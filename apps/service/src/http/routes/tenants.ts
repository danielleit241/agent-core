import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { TENANT_ID_PATTERN, createApiKey, createTenant } from '@agent-core/store-postgres'
import type { createPool } from '@agent-core/store-postgres'
import { requireAdmin } from '../auth'
import { apiError, validationError } from '../errors'

const TenantBody = z.object({ id: z.string().regex(TENANT_ID_PATTERN, { message: 'must match ^[a-z0-9_-]{1,64}$' }) }).strict()

export function registerTenantRoutes(app: FastifyInstance, deps: { pool: ReturnType<typeof createPool> }): void {
  app.post('/v1/tenants', { config: { idempotent: true } }, async (req, reply) => {
    requireAdmin(req)
    const parsed = TenantBody.safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error)
    const created = await createTenant(deps.pool, parsed.data.id)
    if (!created) {
      throw apiError('tenant_exists', `Tenant "${parsed.data.id}" already exists.`, 'Use a different tenant id.', 409)
    }
    // The key is shown once. The idempotency record keeps no copy of it.
    return reply.code(201).send({ id: created.id, api_key: created.apiKey })
  })

  app.post<{ Params: { id: string } }>('/v1/tenants/:id/keys', { config: { idempotent: true } }, async (req, reply) => {
    requireAdmin(req)
    const apiKey = TENANT_ID_PATTERN.test(req.params.id) ? await createApiKey(deps.pool, req.params.id) : null
    if (apiKey === null) {
      throw apiError('tenant_not_found', `Tenant "${req.params.id}" does not exist.`, 'Create the tenant with POST /v1/tenants first.', 404)
    }
    // The key is shown once. The idempotency record keeps no copy of it.
    return reply.code(201).send({ tenant_id: req.params.id, api_key: apiKey })
  })
}
