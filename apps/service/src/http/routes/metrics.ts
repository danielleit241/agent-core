import type { FastifyInstance } from 'fastify'
import { RunStatusSchema } from '@agent-core/core'
import { withClaim } from '@agent-core/store-postgres'
import type { createPool } from '@agent-core/store-postgres'
import { metrics } from '../../metrics'

const DELIVERY_STATUSES = ['pending', 'failed'] as const

async function gauges(pool: ReturnType<typeof createPool>): Promise<string> {
  // agentcore_claim sees the status and queue columns across tenants; the counts carry no tenant data.
  const { runs, queue, deliveries } = await withClaim(pool, async (client) => ({
    runs: await client.query<{ status: string; n: string }>('SELECT status, count(*) AS n FROM runs GROUP BY status'),
    queue: await client.query<{ n: string }>('SELECT count(*) AS n FROM queue'),
    deliveries: await client.query<{ status: string; n: string }>(
      "SELECT status, count(*) AS n FROM webhook_deliveries WHERE status IN ('pending', 'failed') GROUP BY status",
    ),
  }))
  const count = (rows: { status: string; n: string }[], status: string) => Number(rows.find((r) => r.status === status)?.n ?? 0)
  const lines = ['# TYPE agent_core_runs gauge']
  for (const status of RunStatusSchema.options) lines.push(`agent_core_runs{status="${status}"} ${count(runs.rows, status)}`)
  lines.push('# TYPE agent_core_queue_jobs gauge', `agent_core_queue_jobs ${Number(queue.rows[0]?.n ?? 0)}`)
  lines.push('# TYPE agent_core_webhook_deliveries gauge')
  for (const status of DELIVERY_STATUSES) lines.push(`agent_core_webhook_deliveries{status="${status}"} ${count(deliveries.rows, status)}`)
  return lines.join('\n') + '\n'
}

export function registerMetricsRoutes(app: FastifyInstance, pool: ReturnType<typeof createPool>): void {
  app.get('/metrics', async (_req, reply) => {
    const body = (await gauges(pool)) + metrics.render()
    return reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8').send(body)
  })
}
