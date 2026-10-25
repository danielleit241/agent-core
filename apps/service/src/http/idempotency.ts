import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { abandonIdempotent, beginIdempotent, completeIdempotent } from '@agent-core/store-postgres'
import type { createPool } from '@agent-core/store-postgres'
import { apiError } from './errors'

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Opt in to the generic `Idempotency-Key` handling (see `registerIdempotency`). */
    idempotent?: boolean
  }
}

const TENANT = 'default'
const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/

/** Returns the `Idempotency-Key` header, undefined when absent. Throws 400 when it is not 1 to 255 printable ASCII characters. */
export function readIdempotencyKey(req: FastifyRequest): string | undefined {
  const raw = req.headers['idempotency-key']
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || !KEY_PATTERN.test(raw)) {
    throw apiError(
      'invalid_idempotency_key',
      'The Idempotency-Key header is not valid.',
      'Use 1 to 255 printable ASCII characters without spaces.',
      400,
    )
  }
  return raw
}

export const keyReused = () =>
  apiError(
    'idempotency_key_reused',
    'This Idempotency-Key was already used with a different request.',
    'Use a new Idempotency-Key for a different request, or repeat the original request.',
    422,
  )

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    )
  }
  return value
}

/** SHA-256 (hex) of the canonical JSON of method, route pattern, path params and parsed body. The query string is not included. */
export function requestHash(req: FastifyRequest): string {
  const json = JSON.stringify(
    canonical({ method: req.method, route: req.routeOptions.url, params: req.params ?? {}, body: req.body ?? null }),
  )
  return createHash('sha256').update(json).digest('hex')
}

/** Removes a top-level `secret`, which an endpoint returns only once and which must not get a second copy at rest. */
function stripSecret(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && 'secret' in parsed) {
      const rest = { ...(parsed as Record<string, unknown>) }
      delete rest.secret
      return JSON.stringify(rest)
    }
  } catch {
    // not JSON: store as it is
  }
  return body
}

/** Adds `Idempotency-Key` handling to every route of `app` that sets `config: { idempotent: true }`. Call before registering the routes. */
export function registerIdempotency(app: FastifyInstance, deps: { pool: ReturnType<typeof createPool> }): void {
  const { pool } = deps
  /** The keys this request claimed. Only the owner may complete or abandon a key. */
  const owned = new WeakMap<FastifyRequest, string>()

  app.addHook('preHandler', async (req, reply) => {
    if (!req.routeOptions.config.idempotent) return
    const key = readIdempotencyKey(req)
    if (key === undefined) return
    const result = await beginIdempotent(pool, TENANT, key, requestHash(req))
    switch (result.state) {
      case 'started':
        owned.set(req, key)
        return
      case 'mismatch':
        throw keyReused()
      case 'in_use':
        throw apiError(
          'idempotency_key_in_use',
          'A request with this Idempotency-Key is still running.',
          'Wait a moment and send the request again.',
          409,
        )
      case 'replay':
        return reply
          .code(result.statusCode)
          .header('content-type', 'application/json; charset=utf-8')
          .header('Idempotent-Replayed', 'true')
          .send(result.body)
    }
  })

  app.addHook('onSend', async (req, reply, payload) => {
    const key = owned.get(req)
    if (key === undefined) return payload
    owned.delete(req)
    if (reply.statusCode >= 200 && reply.statusCode < 300) {
      await completeIdempotent(pool, TENANT, key, reply.statusCode, stripSecret(typeof payload === 'string' ? payload : String(payload ?? '')))
    } else {
      await abandonIdempotent(pool, TENANT, key)
    }
    return payload
  })
}
