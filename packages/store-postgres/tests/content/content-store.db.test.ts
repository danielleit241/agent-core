import pg from 'pg'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { contentHash } from '@agent-core/core'
import { PgContentStore, assertTestDatabase, createPool, runMigrations, runtimeTestUrl } from '../../src'

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

const rows = async (tenant: string): Promise<number> =>
  (await migrator.query('SELECT 1 FROM context_blobs WHERE tenant_id = $1', [tenant])).rowCount ?? 0

test('put twice with the same text keeps one row and returns the same hash', async () => {
  const store = new PgContentStore(pool, 'a')
  const [h1] = await store.put(['hello'])
  const [h2] = await store.put(['hello'])
  expect(h1).toBe(contentHash('hello'))
  expect(h2).toBe(h1)
  expect(await rows('a')).toBe(1)
})

test('put of 3 texts with 1 existing inserts 2; hashes keep the input order; a repeated text counts once', async () => {
  const store = new PgContentStore(pool, 'a')
  await store.put(['two'])
  expect(await store.put(['one', 'two', 'three', 'one'])).toEqual(['one', 'two', 'three', 'one'].map(contentHash))
  expect(await rows('a')).toBe(3)
})

test('get returns the texts that exist and skips the others', async () => {
  const store = new PgContentStore(pool, 'a')
  const [h] = await store.put(['kept'])
  expect(await store.get([h!, contentHash('absent')])).toEqual(new Map([[h!, 'kept']]))
  expect(await store.get([])).toEqual(new Map())
})

test('get from another tenant finds nothing, and the same text is stored once per tenant', async () => {
  const a = new PgContentStore(pool, 'a')
  const b = new PgContentStore(pool, 'b')
  const [h] = await a.put(['secret'])
  expect((await b.get([h!])).size).toBe(0)
  await b.put(['secret'])
  expect(await rows('a')).toBe(1)
  expect(await rows('b')).toBe(1)
})

test('put with no texts touches nothing', async () => {
  expect(await new PgContentStore(pool, 'a').put([])).toEqual([])
})

test('parallel puts of the same texts in opposite orders do not deadlock', async () => {
  const texts = Array.from({ length: 40 }, (_, i) => `part ${i}`)
  const stores = Array.from({ length: 6 }, () => new PgContentStore(pool, 'a'))
  await Promise.all(stores.map((st, i) => st.put(i % 2 === 0 ? texts : [...texts].reverse())))
  expect(await rows('a')).toBe(40)
})
