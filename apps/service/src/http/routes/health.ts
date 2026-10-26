import type { FastifyInstance } from 'fastify'
import type { createPool } from '@agent-core/store-postgres'
import { runReadyChecks } from '../../checks'

export function registerHealthRoutes(app: FastifyInstance, pool: ReturnType<typeof createPool>): void {
  app.get('/healthz', async (_req, reply) => {
    try {
      await pool.query('SELECT 1')
      return { status: 'ok', db: 'ok' }
    } catch {
      return reply.code(503).send({ status: 'degraded', db: 'error' })
    }
  })

  // Public like /healthz. The checks carry codes and fixes only, never a URL or a secret.
  app.get('/readyz', async (_req, reply) => {
    const checks = await runReadyChecks({ pool })
    const ready = checks.every((c) => c.ok)
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks })
  })
}
