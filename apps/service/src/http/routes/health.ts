import type { FastifyInstance } from 'fastify'
import type { createPool } from '@agent-core/store-postgres'

export function registerHealthRoutes(app: FastifyInstance, pool: ReturnType<typeof createPool>): void {
  app.get('/healthz', async (_req, reply) => {
    try {
      await pool.query('SELECT 1')
      return { status: 'ok', db: 'ok' }
    } catch {
      return reply.code(503).send({ status: 'degraded', db: 'error' })
    }
  })
}
