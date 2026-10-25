import { createHmac, timingSafeEqual } from 'node:crypto'

const ISSUER = 'agent-core'
const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
const FUTURE_SKEW_SEC = 60

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
const mac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest()

/** Signs the principal as an HS256 JWT with the connection secret. `audience` is the connection id. */
export function signPrincipalJwt(
  p: { id: string; roles: string[] },
  o: { secret: string; audience: string; nowSec: number; ttlSec?: number },
): string {
  const claims = { iss: ISSUER, aud: o.audience, sub: p.id, roles: p.roles, iat: o.nowSec, exp: o.nowSec + (o.ttlSec ?? 300) }
  const head = `${HEADER}.${b64(claims)}`
  return `${head}.${mac(o.secret, head).toString('base64url')}`
}

/** Never throws: any malformed or untrusted token returns null. */
export function verifyPrincipalJwt(
  token: string,
  o: { secret: string; audience: string; nowSec: number },
): { sub: string; roles: string[] } | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [h, c, s] = parts as [string, string, string]
  try {
    const header: unknown = JSON.parse(Buffer.from(h, 'base64url').toString())
    if (typeof header !== 'object' || header === null || (header as { alg?: unknown }).alg !== 'HS256') return null
    const given = Buffer.from(s, 'base64url')
    const expected = mac(o.secret, `${h}.${c}`)
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
    const claims: unknown = JSON.parse(Buffer.from(c, 'base64url').toString())
    if (typeof claims !== 'object' || claims === null) return null
    const { iss, aud, sub, roles, iat, exp } = claims as Record<string, unknown>
    if (iss !== ISSUER || aud !== o.audience || typeof sub !== 'string') return null
    if (!Array.isArray(roles) || !roles.every((r) => typeof r === 'string')) return null
    if (typeof iat !== 'number' || typeof exp !== 'number') return null
    if (exp <= o.nowSec || iat > o.nowSec + FUTURE_SKEW_SEC) return null
    return { sub, roles: roles as string[] }
  } catch {
    return null
  }
}
