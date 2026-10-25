import type pg from 'pg'

export const TENANT_ID_PATTERN = /^[a-z0-9_-]{1,64}$/

export class InvalidTenantError extends Error {
  constructor() {
    super('invalid tenant id')
    this.name = 'InvalidTenantError'
  }
}

type Role = 'agentcore_app' | 'agentcore_claim'

/**
 * Runs `fn` in a transaction as `role`. Role and tenant are set with set_config(..., true), which ends at COMMIT or
 * ROLLBACK, so a pooled connection keeps neither. The connection goes back to the pool unless ROLLBACK itself fails.
 */
async function inScope<T>(pool: pg.Pool, role: Role, tenantId: string | null, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let release: Error | undefined
  try {
    await client.query('BEGIN')
    // One round trip. The role is a closed union, never user input; both values are parameters.
    if (tenantId === null) await client.query("SELECT set_config('role', $1, true)", [role])
    else await client.query("SELECT set_config('role', $1, true), set_config('app.tenant_id', $2, true)", [role, tenantId])
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackErr) {
      // The connection state is unknown: make the pool drop it. The original error is still the one thrown.
      release = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr))
    }
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
