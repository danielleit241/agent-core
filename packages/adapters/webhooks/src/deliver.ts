import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { signWebhook } from './sign'

export const RETRY_DELAYS_S = [10, 30, 120, 600, 1800, 3600, 14400, 43200]

export type WebhookEventType = 'run.completed' | 'run.failed' | 'approval.requested'

const LEASE_S = 60
const SEND_TIMEOUT_MS = 10_000
const MAX_ERROR_LEN = 500

/**
 * Creates one pending delivery per webhook subscribed to `type`. All deliveries share one body and event id.
 * A caller that passes a deterministic `eventId` can repeat the call safely: a second call adds nothing.
 */
export async function enqueueWebhookEvent(
  pool: Pool,
  tenantId: string,
  type: WebhookEventType,
  data: object,
  eventId: string = `evt_${randomUUID()}`,
): Promise<void> {
  const body = JSON.stringify({ event_id: eventId, type, created_at: new Date().toISOString(), data })
  await pool.query(
    `INSERT INTO webhook_deliveries (id, tenant_id, webhook_id, event_id, type, body)
     SELECT 'whd_' || gen_random_uuid(), tenant_id, id, $2, $3, $4
       FROM webhooks WHERE tenant_id = $1 AND $3 = ANY(events)
     ON CONFLICT (webhook_id, event_id) DO NOTHING`,
    [tenantId, eventId, type, body],
  )
}

export interface DeliveryWorkerDeps {
  pool: Pool
  fetch?: typeof fetch
  pollMs?: number
  nowSec?: () => number
  delaysS?: number[]
}

interface Claimed {
  id: string
  event_id: string
  body: string
  attempts: number
  url: string
  secret: string
}

// Claims one due delivery with a single statement. The 60 s lease means a crash mid-send retries later.
export const CLAIM_SQL = `
  UPDATE webhook_deliveries d
     SET next_attempt_at = now() + interval '${LEASE_S} seconds'
    FROM webhooks w
   WHERE d.id = (
           SELECT id FROM webhook_deliveries
            WHERE status = 'pending' AND next_attempt_at <= now()
              AND EXISTS (SELECT 1 FROM webhooks w2 WHERE w2.tenant_id = webhook_deliveries.tenant_id AND w2.id = webhook_deliveries.webhook_id)
            ORDER BY next_attempt_at
              FOR UPDATE SKIP LOCKED
            LIMIT 1)
     AND w.tenant_id = d.tenant_id AND w.id = d.webhook_id
  RETURNING d.id, d.event_id, d.body, d.attempts, w.url, w.secret`

export function startDeliveryWorker(deps: DeliveryWorkerDeps): { stop(): Promise<void> } {
  const { pool } = deps
  const doFetch = deps.fetch ?? fetch
  const pollMs = deps.pollMs ?? 1000
  const nowSec = deps.nowSec ?? ((): number => Math.floor(Date.now() / 1000))
  const delaysS = deps.delaysS ?? RETRY_DELAYS_S
  let stopped = false
  let wake: (() => void) | undefined

  async function send(d: Claimed): Promise<string | null> {
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

  // Returns false when nothing was due.
  async function deliverOne(): Promise<boolean> {
    const { rows } = await pool.query<Claimed>(CLAIM_SQL)
    const d = rows[0]
    if (!d) return false
    const error = await send(d)
    if (error === null) {
      await pool.query(
        `UPDATE webhook_deliveries SET status = 'delivered', attempts = attempts + 1, last_error = NULL WHERE id = $1 AND status = 'pending'`,
        [d.id],
      )
      return true
    }
    const attempts = d.attempts + 1
    const delay = delaysS[attempts - 1]
    if (delay === undefined) {
      await pool.query(`UPDATE webhook_deliveries SET status = 'failed', attempts = $2, last_error = $3 WHERE id = $1 AND status = 'pending'`, [
        d.id,
        attempts,
        error,
      ])
    } else {
      await pool.query(
        `UPDATE webhook_deliveries SET attempts = $2, last_error = $3, next_attempt_at = now() + make_interval(secs => $4) WHERE id = $1 AND status = 'pending'`,
        [d.id, attempts, error, delay],
      )
    }
    return true
  }

  const loop = (async (): Promise<void> => {
    while (!stopped) {
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
