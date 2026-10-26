import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withTenant } from '@agent-core/store-postgres'
import type { createPool } from '@agent-core/store-postgres'
import { apiError, validationError } from '../errors'

const ListQuery = z.object({
  status: z.enum(['pending', 'delivered', 'failed']).default('failed'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

interface Row {
  id: string
  webhook_id: string
  event_id: string
  type: string
  attempts: number
  last_error: string | null
  next_attempt_at: Date
  updated_at: Date
}

const view = (r: Row) => ({
  id: r.id,
  webhook_id: r.webhook_id,
  event_id: r.event_id,
  type: r.type,
  attempts: r.attempts,
  last_error: r.last_error,
  next_attempt_at: r.next_attempt_at.toISOString(),
  updated_at: r.updated_at.toISOString(),
})

/** The dead-letter list (deliveries with status `failed`) and the resend of one of them. The body of a delivery is never returned. */
export function registerDeliveryRoutes(app: FastifyInstance, deps: { pool: ReturnType<typeof createPool> }): void {
  const { pool } = deps

  app.get('/v1/deliveries', async (req) => {
    const query = ListQuery.safeParse(req.query)
    if (!query.success) throw validationError(query.error)
    const { status, limit } = query.data
    const { rows } = await withTenant(pool, req.auth.tenantId, (db) =>
      db.query<Row>(
        `SELECT id, webhook_id, event_id, type, attempts, last_error, next_attempt_at, updated_at
           FROM webhook_deliveries WHERE status = $1 ORDER BY updated_at DESC, id DESC LIMIT $2`,
        [status, limit],
      ),
    )
    return { deliveries: rows.map(view) }
  })

  app.post<{ Params: { id: string } }>('/v1/deliveries/:id/retry', { config: { idempotent: true } }, async (req, reply) => {
    const { id } = req.params
    const outcome = await withTenant(pool, req.auth.tenantId, async (db) => {
      const done = await db.query(
        `UPDATE webhook_deliveries
            SET status = 'pending', attempts = 0, last_error = NULL, next_attempt_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'failed'`,
        [id],
      )
      if (done.rowCount === 1) return 'queued'
      return (await db.query('SELECT 1 FROM webhook_deliveries WHERE id = $1', [id])).rowCount === 1 ? 'not_failed' : 'missing'
    })
    if (outcome === 'missing') {
      throw apiError('delivery_not_found', `Delivery "${id}" does not exist.`, 'List failed deliveries with GET /v1/deliveries?status=failed.', 404)
    }
    if (outcome === 'not_failed') {
      throw apiError('delivery_not_failed', 'Only a failed delivery can be retried.', 'List failed deliveries with GET /v1/deliveries?status=failed.', 409)
    }
    return reply.code(202).send({ id, status: 'pending' })
  })
}
