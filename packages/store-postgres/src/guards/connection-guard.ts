import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { BREAKER, resolveConnectionLimits } from '@agent-core/core'
import type { ConnectionGuard, ConnectionLimits, GuardDenial } from '@agent-core/core'
import { withTenant } from '../db/scope'

/** Same as the job lock timeout: a lease of a dead worker frees its slot after this long. */
const LEASE_TTL_S = 300

interface GuardRow {
  window_start: Date
  window_calls: number
  opened_at: Date | null
  trial_lease: string | null
  now: Date
  minute: Date
}

const iso = (d: Date, addS: number): string => new Date(d.getTime() + addS * 1000).toISOString()

/** Connection guard with shared state in Postgres. The guard row lock serialises all calls of one connection; time is the database clock. */
export class PgConnectionGuard implements ConnectionGuard {
  constructor(
    private readonly pool: pg.Pool,
    private readonly tenantId: string,
    private readonly limits: Record<string, Partial<ConnectionLimits> | undefined>,
  ) {}

  acquire(connectionId: string): Promise<{ lease: string } | { denied: GuardDenial }> {
    const limits = resolveConnectionLimits(this.limits[connectionId])
    const key = [this.tenantId, connectionId]
    return withTenant(this.pool, this.tenantId, async (client) => {
      await client.query(
        `INSERT INTO connection_guards (tenant_id, connection_id, window_start)
         VALUES ($1, $2, date_trunc('minute', now())) ON CONFLICT DO NOTHING`,
        key,
      )
      const { rows } = await client.query<GuardRow>(
        `SELECT window_start, window_calls, opened_at, trial_lease, now() AS now, date_trunc('minute', now()) AS minute
         FROM connection_guards WHERE tenant_id = $1 AND connection_id = $2 FOR UPDATE`,
        key,
      )
      const guard = rows[0]
      if (!guard) throw new Error('connection guard row missing')
      await client.query('DELETE FROM connection_leases WHERE tenant_id = $1 AND connection_id = $2 AND expires_at <= now()', key)

      let trial = false
      if (guard.opened_at !== null) {
        if (guard.now.getTime() < guard.opened_at.getTime() + BREAKER.openS * 1000) {
          return { denied: { reason: 'breaker', retryAt: iso(guard.opened_at, BREAKER.openS) } }
        }
        if (guard.trial_lease !== null) {
          const live = await client.query('SELECT 1 FROM connection_leases WHERE id = $1', [guard.trial_lease])
          if (live.rowCount !== 0) return { denied: { reason: 'breaker', retryAt: iso(guard.now, BREAKER.openS) } }
        }
        trial = true
      }

      const live = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM connection_leases WHERE tenant_id = $1 AND connection_id = $2',
        key,
      )
      if ((live.rows[0]?.n ?? 0) >= limits.concurrency) return { denied: { reason: 'concurrency', retryAt: null } }

      // Fixed one-minute window.
      let windowStart = guard.window_start
      let windowCalls = guard.window_calls
      if (guard.now.getTime() >= windowStart.getTime() + 60_000) {
        windowStart = guard.minute
        windowCalls = 0
        await client.query('UPDATE connection_guards SET window_start = $3, window_calls = 0 WHERE tenant_id = $1 AND connection_id = $2', [
          ...key,
          windowStart,
        ])
      }
      if (windowCalls >= limits.calls_per_minute) return { denied: { reason: 'rate', retryAt: iso(windowStart, 60) } }

      const lease = randomUUID()
      await client.query(
        `INSERT INTO connection_leases (id, tenant_id, connection_id, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
        [lease, ...key, LEASE_TTL_S],
      )
      await client.query(
        `UPDATE connection_guards SET window_calls = window_calls + 1, trial_lease = CASE WHEN $3 THEN $4::uuid ELSE trial_lease END
         WHERE tenant_id = $1 AND connection_id = $2`,
        [...key, trial, lease],
      )
      return { lease }
    })
  }

  release(lease: string, outcome: 'ok' | 'failed'): Promise<void> {
    return withTenant(this.pool, this.tenantId, async (client) => {
      const found = await client.query<{ connection_id: string }>('SELECT connection_id FROM connection_leases WHERE id = $1', [lease])
      const connectionId = found.rows[0]?.connection_id
      if (connectionId === undefined) return // already released, or expired and cleaned
      const key = [this.tenantId, connectionId]
      await client.query('SELECT 1 FROM connection_guards WHERE tenant_id = $1 AND connection_id = $2 FOR UPDATE', key)
      const deleted = await client.query('DELETE FROM connection_leases WHERE id = $1', [lease])
      if (deleted.rowCount === 0) return // a parallel release won the lock first
      if (outcome === 'ok') {
        await client.query(
          `UPDATE connection_guards SET failures = 0,
             opened_at = CASE WHEN trial_lease = $3::uuid THEN NULL ELSE opened_at END,
             trial_lease = CASE WHEN trial_lease = $3::uuid THEN NULL ELSE trial_lease END
           WHERE tenant_id = $1 AND connection_id = $2`,
          [...key, lease],
        )
      } else {
        await client.query(
          `UPDATE connection_guards SET failures = failures + 1,
             opened_at = CASE WHEN trial_lease = $3::uuid THEN now()
                              WHEN opened_at IS NULL AND failures + 1 >= $4 THEN now()
                              ELSE opened_at END,
             trial_lease = CASE WHEN trial_lease = $3::uuid THEN NULL ELSE trial_lease END
           WHERE tenant_id = $1 AND connection_id = $2`,
          [...key, lease, BREAKER.failures],
        )
      }
    })
  }
}
