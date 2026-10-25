import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
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
