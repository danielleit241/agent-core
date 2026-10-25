import type pg from 'pg'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { assertTestDatabase, createPool, createTenant, resolveApiKey, runMigrations, runtimeTestUrl } from '../../src'

const url = process.env.TEST_DATABASE_URL ?? 'postgres://agentcore:agentcore@localhost:5433/agentcore_test'
let migrator: pg.Pool
let pool: pg.Pool

beforeAll(() => {
  assertTestDatabase(url)
  migrator = createPool(url)
  pool = createPool(runtimeTestUrl(url))
})
beforeEach(async () => {
  await migrator.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(migrator, { runtimeUser: 'agentcore_runtime' })
})
afterAll(async () => {
  await pool.end()
  await migrator.end()
})

test('createTenant returns a key that resolves to the tenant', async () => {
  const created = await createTenant(pool, 'acme')
  expect(created?.id).toBe('acme')
  expect(created?.apiKey).toMatch(/^ak_v1\.acme\.[A-Za-z0-9_-]{43}$/)
  expect(await resolveApiKey(pool, created!.apiKey)).toBe('acme')
  const stored = await migrator.query<{ key_hash: Buffer }>('SELECT key_hash FROM api_keys WHERE tenant_id = $1', ['acme'])
  expect(stored.rowCount).toBe(1)
  expect(stored.rows[0]!.key_hash.toString('utf8')).not.toContain('ak_v1')
})

test('createTenant of an existing id returns null', async () => {
  expect(await createTenant(pool, 'acme')).not.toBeNull()
  expect(await createTenant(pool, 'acme')).toBeNull()
  expect(await createTenant(pool, 'default')).toBeNull()
  expect((await migrator.query('SELECT 1 FROM api_keys WHERE tenant_id = $1', ['acme'])).rowCount).toBe(1)
})

test('resolveApiKey returns null for a wrong secret, an unknown tenant, a malformed key and a key naming another tenant', async () => {
  const a = (await createTenant(pool, 'a'))!
  const b = (await createTenant(pool, 'b'))!
  const secretA = a.apiKey.split('.')[2]!
  const secretB = b.apiKey.split('.')[2]!
  expect(await resolveApiKey(pool, `ak_v1.a.${'x'.repeat(43)}`)).toBeNull()
  expect(await resolveApiKey(pool, `ak_v1.ghost.${secretA}`)).toBeNull()
  expect(await resolveApiKey(pool, `ak_v1.a.${secretB}`)).toBeNull()
  for (const bad of ['', 'garbage', 'ak_v1.a', 'ak_v1.a.', `ak_v2.a.${secretA}`, `ak_v1.A.${secretA}`, `ak_v1.a.b.${secretA}`, `ak_v1.a'; DROP.${secretA}`]) {
    expect(await resolveApiKey(pool, bad)).toBeNull()
  }
  expect(await resolveApiKey(pool, `ak_v1.${'a'.repeat(65)}.${secretA}`)).toBeNull()
})
