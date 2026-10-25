import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type pg from 'pg'
import { TENANT_ID_PATTERN, withTenant } from '../db/scope'

const KEY_PATTERN = /^ak_v1\.([a-z0-9_-]{1,64})\.([A-Za-z0-9_-]+)$/

const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest()

/** A new key for `tenantId`: the plain key (returned once) and the SHA-256 that is stored. */
function buildApiKey(tenantId: string): { apiKey: string; hash: Buffer } {
  const apiKey = `ak_v1.${tenantId}.${randomBytes(32).toString('base64url')}`
  return { apiKey, hash: sha256(apiKey) }
}

/** Creates the tenant and its first API key. Returns null when the tenant exists. The key is returned once; only its SHA-256 is stored. */
export async function createTenant(pool: pg.Pool, id: string): Promise<{ id: string; apiKey: string } | null> {
  const { apiKey, hash } = buildApiKey(id)
  return withTenant(pool, id, async (client) => {
    const inserted = await client.query('INSERT INTO tenants (id) VALUES ($1) ON CONFLICT DO NOTHING', [id])
    if (inserted.rowCount === 0) return null
    await client.query('INSERT INTO api_keys (tenant_id, id, key_hash) VALUES ($1, $2, $3)', [id, `key_${randomUUID()}`, hash])
    return { id, apiKey }
  })
}

/** Adds another API key to an existing tenant; older keys keep working. Returns null when the tenant does not exist. */
export async function createApiKey(pool: pg.Pool, tenantId: string): Promise<string | null> {
  const { apiKey, hash } = buildApiKey(tenantId)
  return withTenant(pool, tenantId, async (client) => {
    const found = await client.query('SELECT 1 FROM tenants WHERE id = $1', [tenantId])
    if (found.rowCount === 0) return null
    await client.query('INSERT INTO api_keys (tenant_id, id, key_hash) VALUES ($1, $2, $3)', [tenantId, `key_${randomUUID()}`, hash])
    return apiKey
  })
}

/** Returns the tenant id that the key belongs to, or null. Compares digests in constant time. Never throws for bad input. */
export async function resolveApiKey(pool: pg.Pool, key: string): Promise<string | null> {
  const match = KEY_PATTERN.exec(key)
  const tenant = match?.[1]
  if (tenant === undefined || !TENANT_ID_PATTERN.test(tenant)) return null
  const rows = await withTenant(pool, tenant, (client) =>
    client.query<{ key_hash: Buffer }>('SELECT key_hash FROM api_keys WHERE tenant_id = $1', [tenant]),
  )
  const given = sha256(key)
  let found = false
  for (const row of rows.rows) found = timingSafeEqual(given, row.key_hash) || found
  return found ? tenant : null
}
