import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { discoverMcpTools } from '@agent-core/tools-mcp'
import type { createPool } from '@agent-core/store-postgres'
import { checkAdminKey } from './auth'
import { ApiError, apiError } from './errors'
import { registerConfigRoutes } from './routes/config'
import { registerHealthRoutes } from './routes/health'
import { registerRunRoutes } from './routes/runs'

export type AppDeps = {
  pool: ReturnType<typeof createPool>
  adminKey: string
  discoverTools?: typeof discoverMcpTools
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false })

  // Ends pending `wait` polls when the app closes, so close() does not hang for up to 30 s.
  const closing = new AbortController()
  app.addHook('preClose', async () => {
    closing.abort()
  })

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, fix: err.fix } })
    }
    const status = (err as { statusCode?: unknown }).statusCode
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({
        error: {
          code: 'invalid_request',
          message: err instanceof Error ? err.message : 'Invalid request.',
          fix: 'Send a valid JSON body with the header "Content-Type: application/json".',
        },
      })
    }
    // Log the error object only: it never carries request headers or the admin key.
    console.error('service: unhandled error', err)
    return reply.code(500).send({
      error: { code: 'internal_error', message: 'Internal server error.', fix: 'Try again later or check the service logs.' },
    })
  })
  app.setNotFoundHandler((_req, reply) => {
    const e = apiError('not_found', 'Route not found.', 'Check the method and path against the API reference.', 404)
    return reply.code(404).send({ error: { code: e.code, message: e.message, fix: e.fix } })
  })

  registerHealthRoutes(app, deps.pool)
  // The auth hook is bound to this plugin's routes, not to the URL text, so path encoding cannot bypass it.
  void app.register(async (v1) => {
    v1.addHook('onRequest', async (req) => {
      checkAdminKey(req.headers.authorization, deps.adminKey)
    })
    registerConfigRoutes(v1, { pool: deps.pool, discoverTools: deps.discoverTools ?? discoverMcpTools })
    registerRunRoutes(v1, { pool: deps.pool, closing: closing.signal })
  })
  return app
}
