import type pg from 'pg'

export const TENANT_ID_PATTERN = /^[a-z0-9_-]{1,64}$/

export class InvalidTenantError extends Error {
  constructor() {
    super('invalid tenant id')
    this.name = 'InvalidTenantError'
  }
}

type Role = 'agentcore_app' | 'agentcore_claim'

/** Runs `fn` in a transaction as `role`. SET LOCAL and set_config(..., true) end at COMMIT or ROLLBACK, so a pooled connection keeps neither. */
async function inScope<T>(pool: pg.Pool, role: Role, tenantId: string | null, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let release: Error | undefined
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL ROLE ${role}`) // role is a closed union, never user input
    if (tenantId !== null) await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId])
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {}) // must not mask the original error
    release = err instanceof Error ? err : new Error(String(err))
    throw err
  } finally {
    client.release(release)
  }
}

/** Transaction as `agentcore_app` with the tenant set; row-level security limits every statement to that tenant. */
export function withTenant<T>(pool: pg.Pool, tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  if (!TENANT_ID_PATTERN.test(tenantId)) return Promise.reject(new InvalidTenantError())
  return inScope(pool, 'agentcore_app', tenantId, fn)
}

/** Transaction as `agentcore_claim`: cross-tenant scheduling columns only (queue, delivery due times). */
export function withClaim<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return inScope(pool, 'agentcore_claim', null, fn)
}

/** Transaction as `agentcore_app` with no tenant; only for tables without RLS (`model_profiles`). */
export function withService<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return inScope(pool, 'agentcore_app', null, fn)
}
