import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createSecretBox } from '@agent-core/core'
import { ConfigRepo, assertTestDatabase, createPool, createTenant, runMigrations, runtimeTestUrl } from '@agent-core/store-postgres'
import { hashAdminKey } from '../../src/bootstrap'
import { buildApp } from '../../src/http/app'

const box = createSecretBox(Buffer.alloc(32, 7))
const url = process.env.TEST_DATABASE_URL ?? 'postgres://agentcore:agentcore@localhost:5433/agentcore_test'
let migrator: ReturnType<typeof createPool>
let pool: ReturnType<typeof createPool>
let app: FastifyInstance
let keyA: string
let keyB: string

beforeAll(() => {
  assertTestDatabase(url)
  migrator = createPool(url)
  pool = createPool(runtimeTestUrl(url))
})
beforeEach(async () => {
  await migrator.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(migrator, { runtimeUser: 'agentcore_runtime' })
  app = buildApp({ secrets: box, pool, adminKeyHash: hashAdminKey('admin') })
  keyA = (await createTenant(pool, 'a'))!.apiKey
  keyB = (await createTenant(pool, 'b'))!.apiKey
  for (const t of ['a', 'b']) await new ConfigRepo(pool, t, box).putWebhook({ id: `w-${t}`, url: 'http://127.0.0.1:1/hook', secret: 's', events: ['run.completed'] })
})
afterAll(async () => {
  await pool.end()
  await migrator.end()
})

async function seed(tenant: string, id: string, status: string, ageMin: number, extra = ''): Promise<void> {
  await migrator.query(
    `INSERT INTO webhook_deliveries (id, tenant_id, webhook_id, event_id, type, body, status, attempts, last_error, next_attempt_at, updated_at)
     VALUES ($1, $2, 'w-' || $2, $1, 'run.completed', 'SECRET-BODY', $3, 8, $4, now() + interval '1 day', now() - make_interval(mins => $5))`,
    [id, tenant, status, extra || (status === 'failed' ? 'HTTP 500' : null), ageMin],
  )
}
const call = (key: string, method: 'GET' | 'POST', path: string, headers: Record<string, string> = {}) =>
  app.inject({ method, url: path, headers: { authorization: `Bearer ${key}`, ...headers } })
const row = async (id: string) => (await migrator.query('SELECT status, attempts, last_error, next_attempt_at <= now() AS due FROM webhook_deliveries WHERE id = $1', [id])).rows[0]

test('GET /v1/deliveries?status=failed lists only the tenant failed rows, newest first, without the body', async () => {
  await seed('a', 'old', 'failed', 30)
  await seed('a', 'new', 'failed', 5)
  await seed('a', 'ok', 'delivered', 1)
  await seed('b', 'other', 'failed', 1)
  const res = await call(keyA, 'GET', '/v1/deliveries?status=failed')
  expect(res.statusCode).toBe(200)
  const { deliveries } = res.json<{ deliveries: Record<string, unknown>[] }>()
  expect(deliveries.map((d) => d.id)).toEqual(['new', 'old'])
  expect(deliveries[0]).toMatchObject({ webhook_id: 'w-a', event_id: 'new', type: 'run.completed', attempts: 8, last_error: 'HTTP 500' })
  expect(deliveries[0]).not.toHaveProperty('body')
  expect(res.body).not.toContain('SECRET-BODY')
})

test('limit defaults to 50, takes up to 200 and refuses more or less', async () => {
  for (let i = 0; i < 60; i++) await seed('a', `f${String(i).padStart(2, '0')}`, 'failed', i)
  expect((await call(keyA, 'GET', '/v1/deliveries?status=failed')).json().deliveries).toHaveLength(50)
  expect((await call(keyA, 'GET', '/v1/deliveries?status=failed&limit=200')).json().deliveries).toHaveLength(60)
  expect((await call(keyA, 'GET', '/v1/deliveries?status=failed&limit=5')).json().deliveries).toHaveLength(5)
  for (const bad of ['500', '0', 'x']) expect((await call(keyA, 'GET', `/v1/deliveries?status=failed&limit=${bad}`)).statusCode).toBe(400)
  expect((await call(keyA, 'GET', '/v1/deliveries?status=bogus')).statusCode).toBe(400)
})

test('POST /v1/deliveries/:id/retry requeues a failed delivery: 202, pending, attempts 0, no error, due now', async () => {
  await seed('a', 'f1', 'failed', 5)
  const res = await call(keyA, 'POST', '/v1/deliveries/f1/retry')
  expect(res.statusCode).toBe(202)
  expect(await row('f1')).toEqual({ status: 'pending', attempts: 0, last_error: null, due: true })
})

test.each(['pending', 'delivered'])('retry of a %s delivery is 409 and leaves the row unchanged', async (status) => {
  await seed('a', 'x1', status, 5)
  const before = await row('x1')
  const res = await call(keyA, 'POST', '/v1/deliveries/x1/retry')
  expect(res.statusCode).toBe(409)
  expect(res.json().error.code).toBe('delivery_not_failed')
  expect(await row('x1')).toEqual(before)
})

test("retry of another tenant's delivery is 404 and leaves the row unchanged", async () => {
  await seed('b', 'fb', 'failed', 5)
  expect((await call(keyA, 'POST', '/v1/deliveries/fb/retry')).statusCode).toBe(404)
  expect((await call(keyA, 'POST', '/v1/deliveries/ghost/retry')).statusCode).toBe(404)
  expect(await row('fb')).toMatchObject({ status: 'failed', attempts: 8 })
  expect((await call(keyB, 'POST', '/v1/deliveries/fb/retry')).statusCode).toBe(202)
})

test('retry with an Idempotency-Key replays the first answer instead of answering 409', async () => {
  await seed('a', 'f1', 'failed', 5)
  const first = await call(keyA, 'POST', '/v1/deliveries/f1/retry', { 'idempotency-key': 'k1' })
  const second = await call(keyA, 'POST', '/v1/deliveries/f1/retry', { 'idempotency-key': 'k1' })
  expect(first.statusCode).toBe(202)
  expect(second.statusCode).toBe(202)
  expect(second.headers['idempotent-replayed']).toBe('true')
})

test('the deliveries routes need a key', async () => {
  expect((await app.inject({ method: 'GET', url: '/v1/deliveries' })).statusCode).toBe(401)
})
