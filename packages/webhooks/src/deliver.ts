import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { signWebhook } from '@agent-core/protocol'

export const RETRY_DELAYS_S = [10, 30, 120, 600, 1800, 3600, 14400, 43200]

export type WebhookEventType = 'run.completed' | 'run.failed' | 'approval.requested' | 'run.waiting_human'

const LEASE_S = 60
const SEND_TIMEOUT_MS = 10_000
const MAX_ERROR_LEN = 500
const DECRYPT_ERROR = 'secret could not be decrypted'

export const DELIVERED_RETENTION_DAYS = 7
export const FAILED_RETENTION_DAYS = 30
const CLEANUP_EVERY_MS = 3_600_000

export type Queryable = Pick<Pool, 'query'>

/** Transactions the worker runs in: `claim` sees scheduling columns of every tenant; `tenant` sees one tenant's rows. */
export interface DeliveryScope {
  claim<T>(fn: (db: Queryable) => Promise<T>): Promise<T>
  tenant<T>(tenantId: string, fn: (db: Queryable) => Promise<T>): Promise<T>
}

/**
 * Creates one pending delivery per webhook subscribed to `type`. All deliveries share one body and event id.
 * A caller that passes a deterministic `eventId` can repeat the call safely: a second call adds nothing.
 * The caller supplies a tenant-scoped client.
 */
export async function enqueueWebhookEvent(
  db: Queryable,
  tenantId: string,
  type: WebhookEventType,
  data: object,
  eventId: string = `evt_${randomUUID()}`,
): Promise<void> {
  const body = JSON.stringify({ event_id: eventId, type, created_at: new Date().toISOString(), data })
  await db.query(
    `INSERT INTO webhook_deliveries (id, tenant_id, webhook_id, event_id, type, body)
     SELECT 'whd_' || gen_random_uuid(), tenant_id, id, $2, $3, $4
       FROM webhooks WHERE tenant_id = $1 AND $3 = ANY(events)
     ON CONFLICT (webhook_id, event_id) DO NOTHING`,
    [tenantId, eventId, type, body],
  )
}

export interface DeliveryWorkerDeps {
  scope: DeliveryScope
  openSecret: (tenantId: string, webhookId: string, sealed: string) => string
  fetch?: typeof fetch
  pollMs?: number
  nowSec?: () => number
  delaysS?: number[]
}

interface Claimed {
  id: string
  tenant_id: string
}

interface Loaded {
  event_id: string
  body: string
  attempts: number
  webhook_id: string
  url: string
  secret: string
}

interface ToSend {
  event_id: string
  body: string
  url: string
  secret: string
}

// Claims one due delivery with a single statement. The 60 s lease means a crash mid-send retries later.
// It touches only the columns the claim role may read and update.
export const CLAIM_SQL = `
  UPDATE webhook_deliveries d
     SET next_attempt_at = now() + interval '${LEASE_S} seconds'
   WHERE d.id = (
           SELECT id FROM webhook_deliveries
            WHERE status = 'pending' AND next_attempt_at <= now()
            ORDER BY next_attempt_at
              FOR UPDATE SKIP LOCKED
            LIMIT 1)
  RETURNING d.id, d.tenant_id`

/** Deletes `delivered` rows older than 7 days and `failed` rows older than 30 days, measured from the last status change. */
export async function cleanupDeliveries(scope: Pick<DeliveryScope, 'claim'>, now: Date = new Date()): Promise<{ delivered: number; failed: number }> {
  const del = (status: string, days: number) => async (db: Queryable): Promise<number> =>
    (await db.query(`DELETE FROM webhook_deliveries WHERE status = $1 AND updated_at < $2::timestamptz - make_interval(days => $3)`, [status, now, days])).rowCount ?? 0
  return scope.claim(async (db) => ({
    delivered: await del('delivered', DELIVERED_RETENTION_DAYS)(db),
    failed: await del('failed', FAILED_RETENTION_DAYS)(db),
  }))
}

export function startDeliveryWorker(deps: DeliveryWorkerDeps): { stop(): Promise<void> } {
  const { scope, openSecret } = deps
  const doFetch = deps.fetch ?? fetch
  const pollMs = deps.pollMs ?? 1000
  const nowSec = deps.nowSec ?? ((): number => Math.floor(Date.now() / 1000))
  const delaysS = deps.delaysS ?? RETRY_DELAYS_S
  let stopped = false
  let wake: (() => void) | undefined
  let lastCleanup = 0

  async function send(d: ToSend): Promise<string | null> {
    try {
      const res = await doFetch(d.url, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json',
          'X-AgentCore-Signature': signWebhook(d.body, d.secret, nowSec()),
          'X-AgentCore-Event-Id': d.event_id,
        },
        body: d.body,
      })
      try {
        await res.body?.cancel()
      } catch {
        // the status is already known; a failed body cancel does not matter
      }
      return res.status >= 200 && res.status < 300 ? null : `HTTP ${res.status}`
    } catch (err) {
      return (err instanceof Error ? err.message : 'send failed').slice(0, MAX_ERROR_LEN)
    }
  }

  // Loads the delivery with its webhook. A missing webhook ends the delivery as failed, so it never blocks the queue.
  const load = (id: string) => async (db: Queryable): Promise<Loaded | null> => {
    const { rows } = await db.query<Loaded>(
      `SELECT d.event_id, d.body, d.attempts, d.webhook_id, w.url, w.secret
         FROM webhook_deliveries d
         JOIN webhooks w ON w.tenant_id = d.tenant_id AND w.id = d.webhook_id
        WHERE d.id = $1`,
      [id],
    )
    if (rows[0]) return rows[0]
    await db.query(`UPDATE webhook_deliveries SET status = 'failed', last_error = 'webhook not found', updated_at = now() WHERE id = $1 AND status = 'pending'`, [id])
    return null
  }

  // Returns false when nothing was due.
  async function deliverOne(): Promise<boolean> {
    const claimed = (await scope.claim((db) => db.query<Claimed>(CLAIM_SQL))).rows[0]
    if (!claimed) return false
    const { id, tenant_id: tenantId } = claimed
    const d = await scope.tenant(tenantId, load(id))
    if (!d) return true
    let secret: string | undefined
    try {
      secret = openSecret(tenantId, d.webhook_id, d.secret)
    } catch {
      // Never put the secret or the ciphertext in the error.
    }
    const error = secret === undefined ? DECRYPT_ERROR : await send({ ...d, secret })
    await scope.tenant(tenantId, async (db) => {
      if (error === null) {
        await db.query(`UPDATE webhook_deliveries SET status = 'delivered', attempts = attempts + 1, last_error = NULL, updated_at = now() WHERE id = $1 AND status = 'pending'`, [
          id,
        ])
        return
      }
      const attempts = d.attempts + 1
      const delay = delaysS[attempts - 1]
      if (delay === undefined) {
        await db.query(`UPDATE webhook_deliveries SET status = 'failed', attempts = $2, last_error = $3, updated_at = now() WHERE id = $1 AND status = 'pending'`, [
          id,
          attempts,
          error,
        ])
      } else {
        await db.query(
          `UPDATE webhook_deliveries SET attempts = $2, last_error = $3, next_attempt_at = now() + make_interval(secs => $4), updated_at = now() WHERE id = $1 AND status = 'pending'`,
          [id, attempts, error, delay],
        )
      }
    })
    return true
  }

  const loop = (async (): Promise<void> => {
    while (!stopped) {
      if (Date.now() - lastCleanup >= CLEANUP_EVERY_MS) {
        lastCleanup = Date.now()
        try {
          await cleanupDeliveries(scope)
        } catch (err) {
          console.error('webhook cleanup error:', err instanceof Error ? err.message : 'unknown error')
        }
      }
      try {
        while (!stopped && (await deliverOne())) {
          // keep claiming until nothing is due
        }
      } catch (err) {
        console.error('webhook delivery loop error:', err instanceof Error ? err.message : 'unknown error')
      }
      if (stopped) break
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollMs)
        wake = (): void => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
  })()

  return {
    async stop(): Promise<void> {
      stopped = true
      wake?.()
      await loop
    },
  }
}
