import pg from 'pg'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createSecretBox } from '@agent-core/core'
import type { NewEvent } from '@agent-core/core'
import {
  ConfigRepo,
  PgRunStore,
  assertTestDatabase,
  beginIdempotent,
  createPool,
  createRun,
  getRun,
  runMigrations,
  runtimeTestUrl,
} from '../../src'

const url = process.env.TEST_DATABASE_URL ?? 'postgres://agentcore:agentcore@localhost:5433/agentcore_test'
const box = createSecretBox(Buffer.alloc(32, 7))
let migrator: pg.Pool
let runtime: pg.Pool

beforeAll(() => {
  assertTestDatabase(url)
  migrator = createPool(url)
  runtime = createPool(runtimeTestUrl(url))
})
beforeEach(async () => {
  await migrator.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(migrator, { runtimeUser: 'agentcore_runtime' })
})
afterAll(async () => {
  await runtime.end()
  await migrator.end()
})

const connection = (url: string) => ({ id: 'shop', kind: 'mcp' as const, url, tools: [] })
const created = (): NewEvent => ({ type: 'run.created', payload: { agentId: 'ag', input: { text: 'hi' } }, labels: ['trusted'] })

test('ConfigRepo of b does not see the connection shop of a', async () => {
  await new ConfigRepo(runtime, 'a', box).putConnection(connection('http://a/mcp'))
  expect(await new ConfigRepo(runtime, 'b', box).getConnection('shop')).toBeNull()
  expect((await new ConfigRepo(runtime, 'a', box).getConnection('shop'))?.url).toBe('http://a/mcp')
})

test('two tenants can each own connection shop with different urls', async () => {
  await new ConfigRepo(runtime, 'a', box).putConnection(connection('http://a/mcp'))
  await new ConfigRepo(runtime, 'b', box).putConnection(connection('http://b/mcp'))
  expect((await new ConfigRepo(runtime, 'a', box).getConnection('shop'))?.url).toBe('http://a/mcp')
  expect((await new ConfigRepo(runtime, 'b', box).getConnection('shop'))?.url).toBe('http://b/mcp')
})

test('getRun and readEvents of b return null and [] for a run of a', async () => {
  await createRun(runtime, { tenantId: 'a', runId: 'r1', agentId: 'ag', agentVersion: 1, input: { text: 'hi' } })
  await new PgRunStore(runtime, 'a').append('r1', [created()])
  expect(await getRun(runtime, 'b', 'r1')).toBeNull()
  expect(await new PgRunStore(runtime, 'b').readEvents('r1')).toEqual([])
  expect(await new PgRunStore(runtime, 'a').readEvents('r1')).toHaveLength(1)
})

test('PgRunStore of b cannot append to a run of a', async () => {
  await createRun(runtime, { tenantId: 'a', runId: 'r1', agentId: 'ag', agentVersion: 1, input: { text: 'hi' } })
  await expect(new PgRunStore(runtime, 'b').append('r1', [created()])).rejects.toThrow(/run not found/)
  expect(await new PgRunStore(runtime, 'a').readEvents('r1')).toEqual([])
})

test('the same idempotency key starts independently in two tenants', async () => {
  expect(await beginIdempotent(runtime, 'a', 'k', 'h1')).toEqual({ state: 'started' })
  expect(await beginIdempotent(runtime, 'b', 'k', 'h2')).toEqual({ state: 'started' })
  expect(await beginIdempotent(runtime, 'a', 'k', 'h2')).toEqual({ state: 'mismatch' })
})
