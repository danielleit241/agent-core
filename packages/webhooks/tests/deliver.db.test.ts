import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { ConfigRepo, assertTestDatabase, createPool, runMigrations, runtimeTestUrl, withClaim, withTenant } from '@agent-core/store-postgres'
import { CLAIM_SQL, enqueueWebhookEvent, startDeliveryWorker } from '../src/deliver'
import type { DeliveryScope, WebhookEventType } from '../src/deliver'
import { verifyWebhook } from '@agent-core/protocol'

const url = process.env.TEST_DATABASE_URL ?? 'postgres://agentcore:agentcore@localhost:5433/agentcore_test'
let migrator: ReturnType<typeof createPool>
let pool: ReturnType<typeof createPool>
const servers: Server[] = []

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
  for (const s of servers) s.close()
  await pool.end()
  await migrator.end()
})

const scope: DeliveryScope = {
  claim: (fn) => withClaim(pool, fn),
  tenant: (t, fn) => withTenant(pool, t, fn),
}
// The worker's openSecret is under test here; the repo stores secrets as given.
const plainBox = { seal: (plain: string): string => plain, open: (sealed: string): string => sealed }
const openSecret = (_tenantId: string, _webhookId: string, sealed: string): string => sealed
const enqueue = (type: WebhookEventType, data: object, eventId?: string): Promise<void> =>
  withTenant(pool, 'default', (db) => enqueueWebhookEvent(db, 'default', type, data, eventId))

interface Received {
  headers: Record<string, string | string[] | undefined>
  body: string
}
// `statuses` are returned in order; the last one repeats.
async function startReceiver(statuses: number[]): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      received.push({ headers: req.headers, body })
      res.statusCode = statuses[Math.min(received.length - 1, statuses.length - 1)]!
      res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  servers.push(server)
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, received }
}

const putWebhook = (id: string, u: string, events: string[]): Promise<void> =>
  new ConfigRepo(pool, 'default', plainBox).putWebhook({ id, url: u, secret: 'whsec_test', events })

async function waitFor(cond: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  expect(await cond()).toBe(true)
}

interface DeliveryRow {
  webhook_id: string
  status: string
  attempts: number
  last_error: string | null
}
const deliveries = async (): Promise<DeliveryRow[]> =>
  (await migrator.query('SELECT webhook_id, status, attempts, last_error FROM webhook_deliveries ORDER BY webhook_id')).rows

test('retries failed deliveries without blocking', async () => {
  const rx = await startReceiver([500, 200])
  await putWebhook('w1', rx.url, ['run.completed'])
  await enqueue('run.completed', { run_id: 'r1' })
  const w = startDeliveryWorker({ scope, openSecret, pollMs: 10, delaysS: [0] })
  await waitFor(() => rx.received.length === 2)
  expect(rx.received[1]!.headers['x-agentcore-event-id']).toBe(rx.received[0]!.headers['x-agentcore-event-id'])
  await waitFor(async () => (await deliveries())[0]?.status === 'delivered')
  await w.stop()
  expect((await deliveries())[0]!.attempts).toBe(2)
})

test('sends a signed body that matches the event id', async () => {
  const rx = await startReceiver([200])
  await putWebhook('w1', rx.url, ['run.completed'])
  await enqueue('run.completed', { run_id: 'r1' })
  const w = startDeliveryWorker({ scope, openSecret, pollMs: 10 })
  await waitFor(() => rx.received.length === 1)
  await w.stop()
  const r = rx.received[0]!
  expect(r.headers['content-type']).toBe('application/json')
  expect(verifyWebhook(r.body, String(r.headers['x-agentcore-signature']), 'whsec_test', Math.floor(Date.now() / 1000))).toBe(true)
  const parsed = JSON.parse(r.body)
  expect(parsed.event_id).toBe(r.headers['x-agentcore-event-id'])
  expect(parsed.event_id).toMatch(/^evt_/)
  expect(parsed.type).toBe('run.completed')
  expect(parsed.data).toEqual({ run_id: 'r1' })
})

test('only webhooks subscribed to the type get a delivery', async () => {
  const rx = await startReceiver([200])
  await putWebhook('w1', rx.url, ['run.failed'])
  await putWebhook('w2', rx.url, ['run.completed'])
  await enqueue('run.completed', {})
  expect((await deliveries()).map((d) => d.webhook_id)).toEqual(['w2'])
})

test('one failing receiver does not block another', async () => {
  const bad = await startReceiver([500])
  const good = await startReceiver([200])
  await putWebhook('w-bad', bad.url, ['run.completed'])
  await putWebhook('w-good', good.url, ['run.completed'])
  await enqueue('run.completed', { run_id: 'r1' })
  const w = startDeliveryWorker({ scope, openSecret, pollMs: 10, delaysS: [3600] })
  await waitFor(async () => (await deliveries()).find((d) => d.webhook_id === 'w-good')?.status === 'delivered')
  await w.stop()
  const bd = (await deliveries()).find((d) => d.webhook_id === 'w-bad')!
  expect(bd.status).toBe('pending')
  expect(bd.attempts).toBe(1)
  expect(bd.last_error).toBe('HTTP 500')
  expect(good.received[0]!.headers['x-agentcore-event-id']).toBe(bad.received[0]!.headers['x-agentcore-event-id'])
})

test('marks a delivery failed after the retry list is exhausted', async () => {
  const rx = await startReceiver([500])
  await putWebhook('w1', rx.url, ['run.completed'])
  await enqueue('run.completed', {})
  const w = startDeliveryWorker({ scope, openSecret, pollMs: 10, delaysS: [0] })
  await waitFor(async () => (await deliveries())[0]?.status === 'failed')
  await w.stop()
  expect((await deliveries())[0]!.attempts).toBe(2)
  expect(rx.received.length).toBe(2)
})

test('a network error is recorded without secrets and schedules a retry', async () => {
  await putWebhook('w1', 'http://127.0.0.1:1/hook', ['run.completed'])
  await enqueue('run.completed', {})
  const w = startDeliveryWorker({ scope, openSecret, pollMs: 10, delaysS: [3600] })
  await waitFor(async () => (await deliveries())[0]?.attempts === 1)
  await w.stop()
  const d = (await deliveries())[0]!
  expect(d.status).toBe('pending')
  expect(d.last_error).toBeTruthy()
  expect(d.last_error).not.toContain('whsec_test')
})

test('a redirect counts as a failure', async () => {
  const rx = await startReceiver([302])
  await putWebhook('w1', rx.url, ['run.completed'])
  await enqueue('run.completed', {})
  const w = startDeliveryWorker({ scope, openSecret, pollMs: 10, delaysS: [3600] })
  await waitFor(async () => (await deliveries())[0]?.attempts === 1)
  await w.stop()
  expect((await deliveries())[0]!.last_error).toBe('HTTP 302')
})

test('a claimed delivery is leased and cannot be claimed again', async () => {
  const rx = await startReceiver([200])
  await putWebhook('w1', rx.url, ['run.completed'])
  await enqueue('run.completed', {})
  expect((await withClaim(pool, (db) => db.query(CLAIM_SQL))).rowCount).toBe(1)
  expect((await withClaim(pool, (db) => db.query(CLAIM_SQL))).rowCount).toBe(0)
})

test('a delivery whose webhook is missing for its tenant does not block the queue', async () => {
  const rx = await startReceiver([200])
  await putWebhook('w1', rx.url, ['run.completed'])
  // orphan: the composite FK makes it unreachable through normal writes, so skip FK checks on a dedicated client
  const setup = await migrator.connect()
  try {
    await setup.query('SET session_replication_role = replica')
    await setup.query(
      `INSERT INTO webhook_deliveries (id, tenant_id, webhook_id, event_id, type, body, next_attempt_at)
       VALUES ('whd_orphan', 'other', 'w1', 'evt_o', 'run.completed', '{}', now() - interval '1 hour')`,
    )
    await setup.query('RESET session_replication_role')
  } finally {
    setup.release()
  }
  await enqueue('run.completed', {})
  const w = startDeliveryWorker({ scope, openSecret, pollMs: 10 })
  await waitFor(() => rx.received.length === 1)
  await w.stop()
  expect(rx.received.length).toBe(1)
})

test('a delivery whose webhook is gone is marked failed and not sent', async () => {
  const rx = await startReceiver([200])
  await putWebhook('w1', rx.url, ['run.completed'])
  const setup = await migrator.connect()
  try {
    await setup.query('SET session_replication_role = replica')
    await setup.query(
      `INSERT INTO webhook_deliveries (id, tenant_id, webhook_id, event_id, type, body, next_attempt_at)
       VALUES ('whd_orphan', 'other', 'w1', 'evt_o', 'run.completed', '{}', now() - interval '1 hour')`,
    )
    await setup.query('RESET session_replication_role')
  } finally {
    setup.release()
  }
  const w = startDeliveryWorker({ scope, openSecret, pollMs: 10 })
  const orphan = async (): Promise<{ status: string; attempts: number; last_error: string | null }> =>
    (await migrator.query("SELECT status, attempts, last_error FROM webhook_deliveries WHERE id = 'whd_orphan'")).rows[0]
  await waitFor(async () => (await orphan()).status === 'failed')
  await w.stop()
  expect((await orphan()).last_error).toBe('webhook not found')
  expect(rx.received.length).toBe(0)
})

test('delivery is signed with the opened secret', async () => {
  const rx = await startReceiver([200])
  await putWebhook('w1', rx.url, ['run.completed'])
  await enqueue('run.completed', {})
  const seen: string[][] = []
  const w = startDeliveryWorker({
    scope,
    openSecret: (t, id, sealed) => {
      seen.push([t, id, sealed])
      return 'plain'
    },
    pollMs: 10,
  })
  await waitFor(() => rx.received.length === 1)
  await w.stop()
  const r = rx.received[0]!
  const now = Math.floor(Date.now() / 1000)
  expect(verifyWebhook(r.body, String(r.headers['x-agentcore-signature']), 'plain', now)).toBe(true)
  expect(verifyWebhook(r.body, String(r.headers['x-agentcore-signature']), 'whsec_test', now)).toBe(false)
  expect(seen[0]).toEqual(['default', 'w1', 'whsec_test'])
})

test('a secret that cannot be decrypted counts as a failed attempt and sends nothing', async () => {
  const rx = await startReceiver([200])
  await putWebhook('w1', rx.url, ['run.completed'])
  await enqueue('run.completed', {})
  const w = startDeliveryWorker({
    scope,
    openSecret: () => {
      throw new Error('boom whsec_test')
    },
    pollMs: 10,
    delaysS: [3600],
  })
  await waitFor(async () => (await deliveries())[0]?.attempts === 1)
  await w.stop()
  const d = (await deliveries())[0]!
  expect(d.status).toBe('pending')
  expect(d.last_error).toBe('secret could not be decrypted')
  expect(rx.received.length).toBe(0)
})

test('enqueueWebhookEvent with the same eventId creates one delivery per webhook', async () => {
  await putWebhook('w1', 'http://127.0.0.1:1/a', ['run.completed'])
  await putWebhook('w2', 'http://127.0.0.1:1/b', ['run.completed'])
  await enqueue('run.completed', { n: 1 }, 'evt_fixed')
  await enqueue('run.completed', { n: 1 }, 'evt_fixed')
  const rows = await migrator.query('SELECT webhook_id, event_id FROM webhook_deliveries ORDER BY webhook_id')
  expect(rows.rows).toEqual([
    { webhook_id: 'w1', event_id: 'evt_fixed' },
    { webhook_id: 'w2', event_id: 'evt_fixed' },
  ])
})
