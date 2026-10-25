import pg from 'pg'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { STRICT_SAFETY, toolFingerprint } from '@agent-core/core'
import type { AgentDefinition } from '@agent-core/core'
import type { Connection, StoredTool } from './config-repo'
import { ConfigRepo, assertTestDatabase, createPool, runMigrations } from '..'

const url = process.env.TEST_DATABASE_URL ?? 'postgres://agentcore:agentcore@localhost:5433/agentcore_test'
let pool: pg.Pool
let repo: ConfigRepo

const definition = {
  name: 'orders.get',
  description: 'Get an order',
  inputSchema: { type: 'object' },
  source: { annotations: { readOnlyHint: true }, declared: { idempotency: true }, supports: ['idempotency-key' as const] },
}
const FINGERPRINT = toolFingerprint(definition)
const tool: StoredTool = {
  ...definition,
  safety: { effect: 'read', idempotency: false, reachesOutside: true, outputLabel: 'untrusted' },
  connectionId: 'shop',
  confirmed: { effect: 'read' },
  reviewedFor: FINGERPRINT,
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

test('connection round trip keeps source and confirmed; upsert and miss', async () => {
  await repo.putConnection({ id: 'shop', kind: 'mcp', url: 'http://a/mcp', tools: [tool] })
  expect(await repo.getConnection('shop')).toEqual({
    id: 'shop',
    kind: 'mcp',
    url: 'http://a/mcp',
    secret: null,
    tools: [{ ...tool, fingerprint: FINGERPRINT, changedSinceReview: false }],
  })
  await repo.putConnection({ id: 'shop', kind: 'mcp', url: 'http://b/mcp', tools: [] })
  expect(await repo.getConnection('shop')).toMatchObject({ url: 'http://b/mcp', tools: [] })
  expect(await repo.getConnection('nope')).toBeNull()
})

test('a webhook connection stores its secret', async () => {
  await repo.putConnection({ id: 'hook', kind: 'webhook', url: 'http://h/x', secret: 's3cret', tools: [tool] })
  expect(await repo.getConnection('hook')).toMatchObject({ kind: 'webhook', secret: 's3cret', tools: [tool] })
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

test('concurrent updateTool calls on one connection both persist', async () => {
  const other: StoredTool = { ...tool, name: 'orders.list', confirmed: {}, reviewedFor: toolFingerprint({ ...definition, name: 'orders.list' }) }
  await repo.putConnection({ id: 'shop', kind: 'mcp', url: 'http://a/mcp', tools: [tool, other] })
  await Promise.all([
    repo.updateTool('shop', 'orders.get', (t) => ({ ...t, confirmed: { ...t.confirmed, reachesOutside: false } })),
    repo.updateTool('shop', 'orders.list', (t) => ({ ...t, confirmed: { effect: 'read' } })),
  ])
  const tools = (await repo.getConnection('shop'))!.tools
  expect(tools.find((t) => t.name === 'orders.get')!.confirmed).toEqual({ effect: 'read', reachesOutside: false })
  expect(tools.find((t) => t.name === 'orders.list')!.confirmed).toEqual({ effect: 'read' })
  expect(await repo.updateTool('shop', 'nope', (t) => t)).toBeNull()
  expect(await repo.updateTool('nope', 'orders.get', (t) => t)).toBeNull()
})

test('a tool stored without a safety source reads as unconfirmed', async () => {
  const legacy: Record<string, unknown> = { ...tool }
  delete legacy.source
  delete legacy.confirmed
  await pool.query(`INSERT INTO connections (tenant_id, id, kind, url, tools) VALUES ('default', 'old', 'mcp', 'http://o/mcp', $1)`, [
    JSON.stringify([legacy]),
  ])
  expect((await repo.getConnection('old'))!.tools[0]).toMatchObject({ source: {}, confirmed: {} })
  // The stored copy said `read`; what runs is recomputed from source and confirmed, so it is strict.
  expect((await repo.getConnection('old'))!.tools[0]!.safety).toEqual(STRICT_SAFETY)
})

test('concurrent upsertConnection calls see each other: one secret, no lost confirmation', async () => {
  const build = (existing: Connection | null) => ({
    kind: 'webhook' as const,
    url: 'http://h/x',
    secret: existing?.secret ?? `s-${Math.random()}`,
    tools: existing?.tools ?? [tool],
  })
  const [a, b] = await Promise.all([repo.upsertConnection('hook', build), repo.upsertConnection('hook', build)])
  expect(a.secret).toBe(b.secret)
  expect((await repo.getConnection('hook'))!.secret).toBe(a.secret)

  // A confirmation written while a re-registration is building is not overwritten.
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const slow = repo.upsertConnection('hook', async (existing) => {
    await gate
    return { kind: 'webhook' as const, url: 'http://h/y', secret: existing!.secret!, tools: existing!.tools }
  })
  const patch = repo.updateTool('hook', 'orders.get', (t) => ({ ...t, confirmed: { ...t.confirmed, outputLabel: 'confidential' } }))
  release()
  await Promise.all([slow, patch])
  expect((await repo.getConnection('hook'))!.tools[0]!.confirmed).toMatchObject({ outputLabel: 'confidential' })
})

test('upsertConnection writes nothing when build throws', async () => {
  await expect(
    repo.upsertConnection('x', () => {
      throw new Error('conflict')
    }),
  ).rejects.toThrow('conflict')
  expect(await repo.getConnection('x')).toBeNull()
})

test('a tool whose definition changed since review drops its confirmation, runs strict and is marked changed', async () => {
  const changed: StoredTool = { ...tool, description: 'Get an order. Also cancels it.' }
  await repo.putConnection({ id: 'shop', kind: 'mcp', url: 'http://a/mcp', tools: [changed] })
  const loaded = (await repo.getConnection('shop'))!.tools[0]!
  expect(loaded).toMatchObject({ confirmed: {}, changedSinceReview: true, reviewedFor: FINGERPRINT, fingerprint: toolFingerprint(changed) })
  expect(loaded.safety).toEqual(STRICT_SAFETY)
})

test('a tool that was never confirmed is also marked changed when its definition changes', async () => {
  const unconfirmed: StoredTool = { ...tool, confirmed: {}, inputSchema: { type: 'object', properties: { cents: { type: 'number' } } } }
  await repo.putConnection({ id: 'shop', kind: 'mcp', url: 'http://a/mcp', tools: [unconfirmed] })
  expect((await repo.getConnection('shop'))!.tools[0]).toMatchObject({ changedSinceReview: true })
})

test('a tool stored before fingerprints existed: changed when it has a confirmation, reviewed when it has none', async () => {
  const confirmedOld: StoredTool = { ...tool }
  delete confirmedOld.reviewedFor
  const plainOld: StoredTool = { ...tool, name: 'orders.list', confirmed: {} }
  delete plainOld.reviewedFor
  await repo.putConnection({ id: 'shop', kind: 'mcp', url: 'http://a/mcp', tools: [confirmedOld, plainOld] })
  const [a, b] = (await repo.getConnection('shop'))!.tools
  expect(a).toMatchObject({ confirmed: {}, changedSinceReview: true })
  expect(b).toMatchObject({ changedSinceReview: false, reviewedFor: b!.fingerprint })
})

test('updateTool returns the tool as read back, and computed fields are not stored', async () => {
  await repo.putConnection({ id: 'shop', kind: 'mcp', url: 'http://a/mcp', tools: [{ ...tool, confirmed: {} }] })
  const updated = await repo.updateTool('shop', 'orders.get', (t) => ({ ...t, confirmed: { effect: 'read' }, reviewedFor: t.fingerprint }))
  expect(updated).toMatchObject({ confirmed: { effect: 'read' }, changedSinceReview: false, safety: { effect: 'read' } })
  const row = await pool.query<{ tools: Record<string, unknown>[] }>("SELECT tools FROM connections WHERE id = 'shop'")
  expect(Object.keys(row.rows[0]!.tools[0]!)).not.toContain('fingerprint')
  expect(Object.keys(row.rows[0]!.tools[0]!)).not.toContain('changedSinceReview')
})

test('updateTool writes nothing when change throws', async () => {
  await repo.putConnection({ id: 'shop', kind: 'mcp', url: 'http://a/mcp', tools: [tool] })
  await expect(
    repo.updateTool('shop', 'orders.get', () => {
      throw new Error('refused')
    }),
  ).rejects.toThrow('refused')
  expect((await repo.getConnection('shop'))!.tools[0]!.confirmed).toEqual({ effect: 'read' })
})
