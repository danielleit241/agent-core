import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { discoverMcpTools } from '@agent-core/tools'
import type { SecretBox } from '@agent-core/core'
import { resolveApiKey, withTenant } from '@agent-core/store-postgres'
import type { createPool } from '@agent-core/store-postgres'
import { applyTenantHeader, authenticate } from './auth'
import { ApiError, apiError } from './errors'
import { registerIdempotency } from './idempotency'
import { registerConfigRoutes } from './routes/config'
import { registerHealthRoutes } from './routes/health'
import { registerModelRoutes } from './routes/models'
import type { ProbeResult } from './routes/models'
import { registerRunRoutes } from './routes/runs'
import { registerTenantRoutes } from './routes/tenants'

export type AppDeps = {
  pool: ReturnType<typeof createPool>
  adminKey: string
  secrets: SecretBox
  discoverTools?: typeof discoverMcpTools
  /** Alias to real model id. */
  models?: Record<string, string>
  probe?: (model: string) => Promise<ProbeResult>
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
    v1.decorateRequest('auth')
    v1.addHook('onRequest', async (req) => {
      const auth = await authenticate(req.headers.authorization, deps.adminKey, (key) => resolveApiKey(deps.pool, key))
      // Resolved here, before the idempotency hook, so idempotency rows live in the target tenant.
      req.auth = await applyTenantHeader(auth, req.headers['x-tenant-id'], req.routeOptions.url ?? req.url, async (id) => {
        const found = await withTenant(deps.pool, id, (client) => client.query('SELECT 1 FROM tenants WHERE id = $1', [id]))
        return found.rowCount === 1
      })
    })
    registerIdempotency(v1, { pool: deps.pool })
    registerConfigRoutes(v1, { pool: deps.pool, secrets: deps.secrets, discoverTools: deps.discoverTools ?? discoverMcpTools })
    registerTenantRoutes(v1, { pool: deps.pool })
    registerModelRoutes(v1, { pool: deps.pool, models: deps.models ?? {}, probe: deps.probe })
    registerRunRoutes(v1, { pool: deps.pool, secrets: deps.secrets, closing: closing.signal })
  })
  return app
}
