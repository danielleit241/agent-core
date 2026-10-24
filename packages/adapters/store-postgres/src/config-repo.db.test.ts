import pg from 'pg'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import type { AgentDefinition, ToolDescriptor } from '@agent-core/core'
import { ConfigRepo, assertTestDatabase, createPool, runMigrations } from './index'

const url = process.env.TEST_DATABASE_URL ?? 'postgres://agentcore:agentcore@localhost:5433/agentcore_test'
let pool: pg.Pool
let repo: ConfigRepo

const tool: ToolDescriptor = {
  name: 'orders.get',
  description: 'Get an order',
  inputSchema: { type: 'object' },
  safety: { effect: 'read', idempotency: false, reachesOutside: true, outputLabel: 'untrusted' },
  connectionId: 'shop',
}
const agent: AgentDefinition = {
  id: 'support',
  instructions: 'Help customers',
  connections: ['shop'],
  autonomy: 'supervised',
  allow: [],
  model: 'default',
}

beforeAll(() => {
  assertTestDatabase(url)
  pool = createPool(url)
})
beforeEach(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(pool)
  repo = new ConfigRepo(pool, 'default')
})
afterAll(async () => {
  await pool.end()
})

test('connection round trip, upsert and miss', async () => {
  await repo.putConnection({ id: 'shop', url: 'http://a/mcp', tools: [tool] })
  expect(await repo.getConnection('shop')).toEqual({ id: 'shop', kind: 'mcp', url: 'http://a/mcp', tools: [tool] })
  await repo.putConnection({ id: 'shop', url: 'http://b/mcp', tools: [] })
  expect(await repo.getConnection('shop')).toMatchObject({ url: 'http://b/mcp', tools: [] })
  expect(await repo.getConnection('nope')).toBeNull()
})

test('putAgent bumps the version on every update', async () => {
  expect(await repo.putAgent(agent)).toEqual({ id: 'support', version: 1 })
  expect(await repo.putAgent({ ...agent, instructions: 'Changed' })).toEqual({ id: 'support', version: 2 })
  expect(await repo.getAgent('support')).toEqual({ definition: { ...agent, instructions: 'Changed' }, version: 2 })
  expect(await repo.getAgent('nope')).toBeNull()
})

test('webhooks are listed', async () => {
  expect(await repo.listWebhooks()).toEqual([])
  await repo.putWebhook({ id: 'w1', url: 'http://h/x', secret: 's', events: ['run.completed'] })
  expect(await repo.listWebhooks()).toEqual([{ id: 'w1', url: 'http://h/x', secret: 's', events: ['run.completed'] }])
})
