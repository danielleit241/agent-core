import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { TENANT_ID_PATTERN } from '@agent-core/store-postgres'
import { apiError } from './errors'

declare module 'fastify' {
  interface FastifyRequest {
    /** Who the key belongs to. Set by the `/v1` auth hook. */
    auth: Auth
  }
}

export type Auth = { tenantId: string; admin: boolean }

/** The tenant the admin key works as. */
export const ADMIN_TENANT = 'default'

const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest()

/**
 * Finds who the Authorization header belongs to. The admin key gives tenant `default` with admin rights; a tenant key
 * (checked by `resolve`) gives its tenant. Every failure throws the same 401, so a caller cannot tell the causes apart.
 */
export async function authenticate(
  header: string | undefined,
  adminKey: string,
  resolve: (key: string) => Promise<string | null>,
): Promise<Auth> {
  const given = header?.match(/^Bearer (.+)$/i)?.[1]
  if (given !== undefined) {
    if (timingSafeEqual(sha256(given), sha256(adminKey))) return { tenantId: ADMIN_TENANT, admin: true }
    const tenantId = await resolve(given)
    if (tenantId !== null) return { tenantId, admin: false }
  }
  throw apiError(
    'unauthorized',
    'Missing or invalid API key.',
    'Send the header "Authorization: Bearer <key>" with a tenant API key or the admin key (AGENT_CORE_ADMIN_KEY).',
    401,
  )
}

/** Throws 403 unless the request used the admin key. */
export function requireAdmin(req: FastifyRequest): void {
  if (!req.auth.admin) {
    throw apiError('forbidden', 'This endpoint needs the admin key.', 'Call it with "Authorization: Bearer <AGENT_CORE_ADMIN_KEY>".', 403)
  }
}

/** Routes where an admin may act for another tenant with the `X-Tenant-Id` header. */
const TENANT_HEADER_ROUTES = /^\/v1\/(connections|webhooks)(\/|$)/

/**
 * Applies `X-Tenant-Id` to `auth`. Only the admin key may send it, and only on the connection and webhook routes
 * (URL registration is admin-only until the SSRF guard exists). `tenantExists` reads the tenants table.
 */
export async function applyTenantHeader(
  auth: Auth,
  header: string | string[] | undefined,
  route: string,
  tenantExists: (id: string) => Promise<boolean>,
): Promise<Auth> {
  if (header === undefined) return auth
  if (!auth.admin || !TENANT_HEADER_ROUTES.test(route) || typeof header !== 'string') {
    throw apiError(
      'tenant_header_not_allowed',
      'The X-Tenant-Id header is not allowed here.',
      'Send X-Tenant-Id only with the admin key, on /v1/connections and /v1/webhooks routes.',
      400,
    )
  }
  if (!TENANT_ID_PATTERN.test(header)) {
    throw apiError('invalid_tenant', 'The X-Tenant-Id header is not a valid tenant id.', 'Use a tenant id that matches ^[a-z0-9_-]{1,64}$.', 400)
  }
  if (!(await tenantExists(header))) {
    throw apiError('tenant_not_found', `Tenant "${header}" does not exist.`, 'Create the tenant with POST /v1/tenants first.', 404)
  }
  return { ...auth, tenantId: header }
}
