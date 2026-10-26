import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import type { NewEvent } from '@agent-core/core'
import { ConfigRepo, PgRunStore, assertTestDatabase, createPool, runtimeTestUrl, createRun, runMigrations } from '@agent-core/store-postgres'
import { buildApp } from '../../src/http/app'
import { createSecretBox } from '@agent-core/core'

const box = createSecretBox(Buffer.alloc(32, 7))
const url = process.env.TEST_DATABASE_URL ?? 'postgres://agentcore:agentcore@localhost:5433/agentcore_test'
const ADMIN_KEY = 'test-admin-key'
let migrator: ReturnType<typeof createPool>
let pool: ReturnType<typeof createPool>
let app: FastifyInstance

beforeAll(() => {
  assertTestDatabase(url)
  migrator = createPool(url)
  pool = createPool(runtimeTestUrl(url))
})
beforeEach(async () => {
  await migrator.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(migrator, { runtimeUser: 'agentcore_runtime' })
  app = buildApp({ secrets: box, pool, adminKey: ADMIN_KEY })
})
afterAll(async () => {
  await pool.end()
  await migrator.end()
})

const agentBody = { id: 'helper', instructions: 'help', connections: [] as string[], autonomy: 'supervised', allow: [] }
const runBody = { agent: 'helper', input: { text: 'hi' } }

function send(method: 'POST' | 'PATCH', path: string, payload: unknown, key?: string) {
  return app.inject({
    method,
    url: path,
    payload: payload as object,
    headers: { authorization: `Bearer ${ADMIN_KEY}`, ...(key === undefined ? {} : { 'idempotency-key': key }) },
  })
}

const count = async (table: string) => Number((await migrator.query(`SELECT count(*) FROM ${table}`)).rows[0].count)
const seedAgent = () => new ConfigRepo(pool, 'default', box).putAgent({ ...agentBody, autonomy: 'supervised', model: 'default' })

async function waitingRun(runId = 'r-wait'): Promise<string> {
  const { version } = await seedAgent()
  await createRun(pool, { tenantId: 'default', runId, agentId: 'helper', agentVersion: version, input: { text: 'hi' } })
  const events: NewEvent[] = [
    { type: 'run.created', payload: { agentId: 'helper', input: { text: 'hi' } }, labels: ['trusted'] },
    { type: 'run.state_changed', payload: { from: 'queued', to: 'running' }, labels: [] },
    { type: 'run.state_changed', payload: { from: 'running', to: 'waiting_human', reason: 'approval' }, labels: [] },
  ]
  await new PgRunStore(pool, 'default').append(runId, events)
  return runId
}

test('POST /v1/runs: same key with a different body is refused, the same body replays', async () => {
  await seedAgent()
  const a = await send('POST', '/v1/runs', runBody, 'k1')
  const other = await send('POST', '/v1/runs', { ...runBody, input: { text: 'other' } }, 'k1')
  expect(other.statusCode).toBe(422)
  expect(other.json().error.code).toBe('idempotency_key_reused')
  const same = await send('POST', '/v1/runs', { input: { text: 'hi' }, agent: 'helper' }, 'k1')
  expect(same.json().run_id).toBe(a.json().run_id)
  expect(same.headers['idempotent-replayed']).toBe('true')
})

test('POST /v1/runs: a stored NULL hash (old row) matches any request', async () => {
  await seedAgent()
  const a = await send('POST', '/v1/runs', runBody, 'k-old')
  await migrator.query('UPDATE runs SET idempotency_request_hash = NULL')
  const b = await send('POST', '/v1/runs', { ...runBody, input: { text: 'other' } }, 'k-old')
  expect(b.statusCode).toBe(202)
  expect(b.json().run_id).toBe(a.json().run_id)
})

test('POST /v1/agents: a replay gives the same answer and changes nothing', async () => {
  const a = await send('POST', '/v1/agents', agentBody, 'a1')
  const b = await send('POST', '/v1/agents', agentBody, 'a1')
  expect(a.statusCode).toBe(201)
  expect(b.statusCode).toBe(a.statusCode)
  expect(b.body).toBe(a.body)
  expect(a.headers['idempotent-replayed']).toBeUndefined()
  expect(b.headers['idempotent-replayed']).toBe('true')
  expect(await count('agents')).toBe(1)
})

test('POST /v1/webhooks: a replay has the same id, no secret, and no secret at rest', async () => {
  const body = { url: 'https://hook.test/in', events: ['run.completed'] }
  const a = await send('POST', '/v1/webhooks', body, 'w1')
  const b = await send('POST', '/v1/webhooks', body, 'w1')
  expect(a.json().secret).toMatch(/^[0-9a-f]{64}$/)
  expect(b.statusCode).toBe(201)
  expect(b.json().id).toBe(a.json().id)
  expect(b.json()).not.toHaveProperty('secret')
  expect(await count('webhooks')).toBe(1)
  const stored = (await migrator.query('SELECT response_body FROM idempotency_keys')).rows[0].response_body as string
  expect(stored).not.toContain(a.json().secret)
})

test('POST /v1/runs/:id/input: a replay appends no second event', async () => {
  const runId = await waitingRun()
  const store = new PgRunStore(pool, 'default')
  const a = await send('POST', `/v1/runs/${runId}/input`, { action: 'cancel' }, 'r1')
  const n = (await store.readEvents(runId)).length
  const b = await send('POST', `/v1/runs/${runId}/input`, { action: 'cancel' }, 'r1')
  expect(a.statusCode).toBe(202)
  expect(b.statusCode).toBe(202)
  expect(b.headers['idempotent-replayed']).toBe('true')
  expect((await store.readEvents(runId)).length).toBe(n)
})

test('the same key on a different endpoint is refused', async () => {
  const runId = await waitingRun()
  await send('POST', '/v1/agents', agentBody, 'shared')
  const res = await send('POST', `/v1/runs/${runId}/input`, { action: 'cancel' }, 'shared')
  expect(res.statusCode).toBe(422)
  expect(res.json().error.code).toBe('idempotency_key_reused')
})

test('a failed request leaves no row, and a retry with the same key succeeds', async () => {
  const bad = await send('POST', '/v1/agents', { ...agentBody, instructions: '' }, 'f1')
  expect(bad.statusCode).toBe(400)
  expect(await count('idempotency_keys')).toBe(0)
  const ok = await send('POST', '/v1/agents', agentBody, 'f1')
  expect(ok.statusCode).toBe(201)
  expect(await count('idempotency_keys')).toBe(1)
})

test.each([['has space'], ['x'.repeat(256)], ['']])('an invalid key %j gives 400 invalid_idempotency_key', async (key) => {
  const res = await send('POST', '/v1/agents', agentBody, key)
  expect(res.statusCode).toBe(400)
  expect(res.json().error.code).toBe('invalid_idempotency_key')
})

test('a request still running gives 409, a crashed one (older than 60 s) is taken over', async () => {
  const body = { url: 'https://hook.test/in', events: ['run.completed'] }
  // A first request on another key gives the hash of this request.
  expect((await send('POST', '/v1/webhooks', body, 'seed')).statusCode).toBe(201)
  const { request_hash } = (await migrator.query('SELECT request_hash FROM idempotency_keys')).rows[0]
  await migrator.query('INSERT INTO idempotency_keys (tenant_id, key, request_hash) VALUES ($1, $2, $3)', ['default', 'busy', request_hash])
  const busy = await send('POST', '/v1/webhooks', body, 'busy')
  expect(busy.statusCode).toBe(409)
  expect(busy.json().error.code).toBe('idempotency_key_in_use')
  await migrator.query("UPDATE idempotency_keys SET created_at = now() - interval '61 seconds' WHERE key = 'busy'")
  const taken = await send('POST', '/v1/webhooks', body, 'busy')
  expect(taken.statusCode).toBe(201)
  expect(await count('webhooks')).toBe(2)
})

test('requests without a key are not recorded', async () => {
  await send('POST', '/v1/agents', agentBody)
  expect(await count('idempotency_keys')).toBe(0)
})
