import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createSecretBox } from '@agent-core/core'
import { assertTestDatabase, createPool, runMigrations, runtimeTestUrl } from '@agent-core/store-postgres'
import { buildApp } from '../../src/http/app'

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
  app = buildApp({ secrets: box, pool, adminKey: ADMIN_KEY, models: { default: 'real-a' } })
})
afterAll(async () => {
  await pool.end()
  await migrator.end()
})

const call = (key: string | undefined, method: 'GET' | 'POST', path: string, payload?: unknown, extra: Record<string, string> = {}) =>
  app.inject({
    method,
    url: path,
    ...(payload === undefined ? {} : { payload: payload as object }),
    headers: { ...(key === undefined ? {} : { authorization: `Bearer ${key}` }), ...extra },
  })

async function newTenant(id: string): Promise<string> {
  const res = await call(ADMIN_KEY, 'POST', '/v1/tenants', { id })
  expect(res.statusCode).toBe(201)
  return res.json().api_key as string
}

const shopBody = {
  id: 'shop',
  kind: 'webhook',
  url: 'http://shop.test/hook',
  tools: [
    {
      name: 'orders.get',
      description: 'get',
      inputSchema: {},
      safety: { effect: 'read', idempotency: false, reachesOutside: false, outputLabel: 'internal' },
    },
  ],
}
const agentBody = { id: 'helper', instructions: 'hi', connections: ['shop'], autonomy: 'supervised', allow: [], model: 'default' }

test('tenant a data is invisible to tenant b and to the admin key', async () => {
  const keyA = await newTenant('a')
  const keyB = await newTenant('b')
  expect(keyA).toMatch(/^ak_v1\.a\./)

  expect((await call(keyA, 'POST', '/v1/connections', shopBody)).statusCode).toBe(201)
  expect((await call(keyA, 'POST', '/v1/agents', agentBody)).statusCode).toBe(201)
  expect((await call(keyA, 'POST', '/v1/webhooks', { url: 'https://hook.test/x', events: ['run.completed'] })).statusCode).toBe(201)
  const run = await call(keyA, 'POST', '/v1/runs', { agent: 'helper', input: { text: 'hi' } })
  expect(run.statusCode).toBe(202)
  const runId = run.json().run_id as string

  // tenant a sees its own data
  expect((await call(keyA, 'GET', `/v1/runs/${runId}`)).statusCode).toBe(200)
  expect((await call(keyA, 'GET', `/v1/runs/${runId}/events`)).statusCode).toBe(200)
  expect((await call(keyA, 'GET', '/v1/connections/shop/tools')).statusCode).toBe(200)

  // tenant b and the admin key (tenant default) do not. Agents and webhooks have no get or list route.
  for (const key of [keyB, ADMIN_KEY]) {
    expect((await call(key, 'GET', `/v1/runs/${runId}`)).statusCode).toBe(404)
    expect((await call(key, 'GET', `/v1/runs/${runId}/events`)).statusCode).toBe(404)
    expect((await call(key, 'POST', `/v1/runs/${runId}/cancel`)).statusCode).toBe(404)
    expect((await call(key, 'GET', '/v1/connections/shop/tools')).statusCode).toBe(404)
    const other = await call(key, 'POST', '/v1/runs', { agent: 'helper', input: { text: 'hi' } })
    expect(other.statusCode).toBe(422)
    expect(other.json().error.code).toBe('unknown_agent')
    const agent = await call(key, 'POST', '/v1/agents', agentBody)
    expect(agent.statusCode).toBe(422)
    expect(agent.json().error.code).toBe('unknown_connection')
  }
})

test('tenant keys cannot call admin endpoints', async () => {
  const keyA = await newTenant('a')
  for (const [method, path, payload] of [
    ['POST', '/v1/tenants', { id: 'c' }],
    ['GET', '/v1/models', undefined],
    ['POST', '/v1/models/check', {}],
  ] as const) {
    const res = await call(keyA, method, path, payload)
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('forbidden')
  }
  expect((await call(ADMIN_KEY, 'GET', '/v1/models')).statusCode).toBe(200)
})

test('every failed key gets the same 401 body', async () => {
  const keyA = await newTenant('a')
  const secretA = keyA.split('.')[2]!
  const attempts = [undefined, 'garbage', `ak_v1.a.${'x'.repeat(43)}`, `ak_v1.ghost.${secretA}`, `ak_v1.a.${secretA}x`]
  const bodies: string[] = []
  for (const key of attempts) {
    const res = await call(key, 'GET', '/v1/runs/x')
    expect(res.statusCode).toBe(401)
    bodies.push(res.body)
  }
  expect(new Set(bodies).size).toBe(1)
  expect(JSON.parse(bodies[0]!).error.code).toBe('unauthorized')
})

test('POST /v1/tenants replays without the api key and stores none', async () => {
  const first = await call(ADMIN_KEY, 'POST', '/v1/tenants', { id: 'a' }, { 'idempotency-key': 'k1' })
  expect(first.statusCode).toBe(201)
  expect(first.json().api_key).toMatch(/^ak_v1\.a\./)
  const again = await call(ADMIN_KEY, 'POST', '/v1/tenants', { id: 'a' }, { 'idempotency-key': 'k1' })
  expect(again.statusCode).toBe(201)
  expect(again.headers['idempotent-replayed']).toBe('true')
  expect(again.json()).toEqual({ id: 'a' })
  const stored = await migrator.query<{ response_body: string }>('SELECT response_body FROM idempotency_keys')
  expect(stored.rows[0]!.response_body).not.toContain('ak_v1.')
})

test('POST /v1/tenants with an existing id gives 409 tenant_exists', async () => {
  await newTenant('a')
  const res = await call(ADMIN_KEY, 'POST', '/v1/tenants', { id: 'a' })
  expect(res.statusCode).toBe(409)
  expect(res.json().error.code).toBe('tenant_exists')
  expect((await call(ADMIN_KEY, 'POST', '/v1/tenants', { id: 'default' })).statusCode).toBe(409)
})

test('POST /v1/tenants rejects a bad id with 400', async () => {
  for (const id of ['A', 'a.b', '', 'x'.repeat(65), "a'; DROP TABLE runs"]) {
    const res = await call(ADMIN_KEY, 'POST', '/v1/tenants', { id })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('invalid_request')
  }
})

test('two tenants can use the same connection id and idempotency key', async () => {
  const keyA = await newTenant('a')
  const keyB = await newTenant('b')
  const ra = await call(keyA, 'POST', '/v1/connections', shopBody, { 'idempotency-key': 'same' })
  const rb = await call(keyB, 'POST', '/v1/connections', shopBody, { 'idempotency-key': 'same' })
  expect(ra.statusCode).toBe(201)
  expect(rb.statusCode).toBe(201)
  expect(rb.headers['idempotent-replayed']).toBeUndefined()
})
