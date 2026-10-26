import type pg from 'pg'
import { withClaim, withTenant } from '../db/scope'

type Job = { runId: string; tenantId: string; availableAt?: Date }

export async function enqueue(pool: pg.Pool, job: Job): Promise<void> {
  await withTenant(pool, job.tenantId, (client) => enqueueWith(client, job))
}

/**
 * Upserts the job on any pool or client, so a caller can do it inside its own transaction.
 * An existing row is unlocked, so a worker still holding it cannot delete the new job.
 */
export async function enqueueWith(db: Pick<pg.Pool, 'query'>, job: Job): Promise<void> {
  await db.query(
    `INSERT INTO queue (run_id, tenant_id, available_at) VALUES ($1, $2, COALESCE($3, now()))
     ON CONFLICT (run_id) DO UPDATE SET available_at = EXCLUDED.available_at, locked_by = NULL, locked_at = NULL`,
    [job.runId, job.tenantId, job.availableAt ?? null],
  )
}

export const DEFAULT_MAX_RUNS_PER_TENANT = 4

/** Fixed key that serialises all claims, so the per-tenant limit holds when workers claim at once. */
const CLAIM_LOCK_KEY = 7_240_001

export type ClaimOptions = { lockTimeoutMs?: number; maxPerTenant?: number }

/**
 * Claims one due job from the tenant with the fewest running jobs, skipping tenants at `maxPerTenant`.
 * A job is running while its lock is younger than `lockTimeoutMs`.
 */
export async function claim(
  pool: pg.Pool,
  workerId: string,
  opts: ClaimOptions = {},
): Promise<{ runId: string; tenantId: string } | null> {
  const lockTimeoutMs = opts.lockTimeoutMs ?? 300000
  const maxPerTenant = opts.maxPerTenant ?? DEFAULT_MAX_RUNS_PER_TENANT
  return withClaim(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [CLAIM_LOCK_KEY])
    const res = await client.query<{ run_id: string; tenant_id: string }>(
      `WITH running AS (
         SELECT tenant_id, count(*) AS n FROM queue
         WHERE locked_at IS NOT NULL AND locked_at >= now() - make_interval(secs => $2 / 1000.0)
         GROUP BY tenant_id)
       UPDATE queue SET locked_by = $1, locked_at = now()
       WHERE run_id = (
         SELECT q.run_id FROM queue q LEFT JOIN running r ON r.tenant_id = q.tenant_id
         WHERE q.available_at <= now() AND (q.locked_at IS NULL OR q.locked_at < now() - make_interval(secs => $2 / 1000.0))
           AND COALESCE(r.n, 0) < $3
         ORDER BY COALESCE(r.n, 0), q.priority DESC, q.available_at
         LIMIT 1 FOR UPDATE OF q SKIP LOCKED)
       RETURNING run_id, tenant_id`,
      [workerId, lockTimeoutMs, maxPerTenant],
    )
    const row = res.rows[0]
    return row ? { runId: row.run_id, tenantId: row.tenant_id } : null
  })
}

export async function release(pool: pg.Pool, runId: string, workerId: string): Promise<void> {
  await withClaim(pool, (client) => client.query('DELETE FROM queue WHERE run_id = $1 AND locked_by = $2', [runId, workerId]))
}

/** Refreshes the lock timestamp. Returns false when this worker no longer holds the job. */
export async function heartbeat(pool: pg.Pool, runId: string, workerId: string): Promise<boolean> {
  const res = await withClaim(pool, (client) =>
    client.query('UPDATE queue SET locked_at = now() WHERE run_id = $1 AND locked_by = $2', [runId, workerId]),
  )
  return (res.rowCount ?? 0) > 0
}

/**
 * Unlocks the job and makes it due at `availableAt` (default now), but only while this worker still holds the lock.
 * A job nudged by `makeDue` while held becomes due now, so input sent meanwhile is not left waiting.
 */
export async function requeueIfHolder(pool: pg.Pool, runId: string, workerId: string, availableAt?: Date): Promise<void> {
  await withClaim(pool, (client) =>
    client.query(
      `UPDATE queue SET available_at = CASE WHEN nudged_at > locked_at THEN now() ELSE COALESCE($3, now()) END,
         locked_by = NULL, locked_at = NULL
       WHERE run_id = $1 AND locked_by = $2`,
      [runId, workerId, availableAt ?? null],
    ),
  )
}

/** Makes the run's job due now without touching its lock: a worker that holds it keeps it. */
export async function makeDue(pool: pg.Pool, tenantId: string, runId: string): Promise<void> {
  await withTenant(pool, tenantId, (client) =>
    client.query('UPDATE queue SET available_at = now(), nudged_at = now() WHERE run_id = $1', [runId]),
  )
}
