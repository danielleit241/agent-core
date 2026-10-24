import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import type { LLMPort, NewEvent, ToolDescriptor } from '@agent-core/core'
import { ConfigRepo, PgRunStore, assertTestDatabase, createPool, createRun, getRunHead, runMigrations } from '@agent-core/store-postgres'
import { buildApp } from './app'
import { checkChain } from './routes/runs'
import { createRunSettledHandler } from './settled'
import { startRunWorker } from './worker'

const url = process.env.TEST_DATABASE_URL ?? 'postgres://agentcore:agentcore@localhost:5433/agentcore_test'
const ADMIN_KEY = 'test-admin-key'
let pool: ReturnType<typeof createPool>
let app: FastifyInstance

const readTool: ToolDescriptor = {
  name: 'orders.get',
  description: 'get an order',
  inputSchema: {},
  safety: { effect: 'read', idempotency: false, reachesOutside: false, outputLabel: 'untrusted' },
  connectionId: 'shop',
}
const discoverTools = async (connectionId: string) => [{ tool: { ...readTool, connectionId }, needsConfirmation: ['idempotency'] }]

beforeAll(() => {
  assertTestDatabase(url)
  pool = createPool(url)
})
beforeEach(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(pool)
  app = buildApp({ pool, adminKey: ADMIN_KEY, discoverTools })
})
afterAll(async () => {
  await pool.end()
})

const agentBody = { id: 'helper', instructions: 'help', connections: [] as string[], autonomy: 'supervised', allow: [] }
const runBody = { agent: 'helper', input: { text: 'hi' } }

function authed(method: 'GET' | 'POST', path: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method,
    url: path,
    payload: payload as object | undefined,
    headers: { authorization: `Bearer ${ADMIN_KEY}`, ...headers },
  })
}

const seedAgent = () => new ConfigRepo(pool, 'default').putAgent({ ...agentBody, autonomy: 'supervised', model: 'default' })

async function runWaitingForApproval(runId = 'r-wait'): Promise<string> {
  const { version } = await seedAgent()
  await createRun(pool, { tenantId: 'default', runId, agentId: 'helper', agentVersion: version, input: { text: 'hi' } })
  const events: NewEvent[] = [
    { type: 'run.created', payload: { agentId: 'helper', input: { text: 'hi' } }, labels: ['trusted'] },
    { type: 'run.state_changed', payload: { from: 'queued', to: 'running' }, labels: [] },
    {
      type: 'llm.responded',
      payload: {
        message: { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'orders.cancel', arguments: { id: 7 } }] },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'tool_calls',
      },
      labels: [],
    },
    {
      type: 'rule.decided',
      payload: { toolCallId: 'call_1', tool: 'orders.cancel', decision: 'require_approval', reason: 'write tool' },
      labels: [],
    },
    {
      type: 'approval.requested',
      payload: { toolCallId: 'call_1', tool: 'orders.cancel', args: { id: 7 }, reason: 'write tool' },
      labels: [],
    },
    { type: 'run.state_changed', payload: { from: 'running', to: 'waiting_human', reason: 'approval' }, labels: [] },
  ]
  await new PgRunStore(pool, 'default').append(runId, events)
  return runId
}

const queueRows = async (runId: string) => (await pool.query('SELECT 1 FROM queue WHERE run_id = $1', [runId])).rowCount

test('rejects requests without the admin key', async () => {
  const res = await app.inject({ method: 'POST', url: '/v1/agents', payload: agentBody })
  expect(res.statusCode).toBe(401)
  expect(res.json().error).toMatchObject({ code: 'unauthorized', fix: expect.any(String) })
  const wrong = await app.inject({ method: 'GET', url: '/v1/runs/x', headers: { authorization: 'Bearer nope' } })
  expect(wrong.statusCode).toBe(401)
  expect(JSON.stringify(wrong.json())).not.toContain(ADMIN_KEY)
})

test('healthz needs no key', async () => {
  expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ status: 'ok', db: 'ok' })
})

test('healthz reports 503 when the database is down', async () => {
  const dead = createPool('postgres://agentcore:agentcore@localhost:1/none')
  const res = await buildApp({ pool: dead, adminKey: ADMIN_KEY }).inject({ method: 'GET', url: '/healthz' })
  await dead.end()
  expect(res.statusCode).toBe(503)
  expect(res.json()).toEqual({ status: 'degraded', db: 'error' })
})

test('bad JSON and unknown routes use the error envelope', async () => {
  const bad = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    payload: '{oops',
    headers: { authorization: `Bearer ${ADMIN_KEY}`, 'content-type': 'application/json' },
  })
  expect(bad.statusCode).toBe(400)
  expect(bad.json().error).toMatchObject({ code: 'invalid_request', fix: expect.any(String) })
  const missing = await app.inject({ method: 'GET', url: '/nope' })
  expect(missing.statusCode).toBe(404)
  expect(missing.json().error).toMatchObject({ code: 'not_found', fix: expect.any(String) })
})

test('creating a connection stores the discovered tools', async () => {
  const res = await authed('POST', '/v1/connections', { id: 'shop', url: 'http://shop.test/mcp' })
  expect(res.statusCode).toBe(201)
  expect(res.json()).toEqual({
    id: 'shop',
    kind: 'mcp',
    tools: [{ name: 'orders.get', safety: readTool.safety, needsConfirmation: ['idempotency'] }],
  })
  const stored = await new ConfigRepo(pool, 'default').getConnection('shop')
  expect(stored?.tools[0]?.connectionId).toBe('shop')
  // an existing id is overwritten
  expect((await authed('POST', '/v1/connections', { id: 'shop', url: 'http://shop2.test/mcp' })).statusCode).toBe(201)
  expect((await new ConfigRepo(pool, 'default').getConnection('shop'))?.url).toBe('http://shop2.test/mcp')
})

test('an unreachable connection gives 422 and a non-http url gives 400', async () => {
  const failing = buildApp({
    pool,
    adminKey: ADMIN_KEY,
    discoverTools: async () => {
      throw new Error('connection_unreachable: boom')
    },
  })
  const res = await failing.inject({
    method: 'POST',
    url: '/v1/connections',
    payload: { id: 'x', url: 'http://down.test' },
    headers: { authorization: `Bearer ${ADMIN_KEY}` },
  })
  expect(res.statusCode).toBe(422)
  expect(res.json().error.code).toBe('connection_unreachable')
  expect((await authed('POST', '/v1/connections', { id: 'x', url: 'ftp://x' })).statusCode).toBe(400)
})

test('agents: version bumps, autonomy and connection checks', async () => {
  const first = await authed('POST', '/v1/agents', agentBody)
  expect(first.statusCode).toBe(201)
  expect(first.json()).toEqual({ id: 'helper', version: 1 })
  expect((await authed('POST', '/v1/agents', agentBody)).json()).toEqual({ id: 'helper', version: 2 })
  const auto = await authed('POST', '/v1/agents', { ...agentBody, autonomy: 'autonomous' })
  expect(auto.statusCode).toBe(400)
  expect(auto.json().error.code).toBe('autonomy_not_supported')
  const invalid = await authed('POST', '/v1/agents', { ...agentBody, instructions: '' })
  expect(invalid.statusCode).toBe(400)
  expect(invalid.json().error).toMatchObject({ code: 'invalid_request', message: expect.stringContaining('instructions') })
})

test('creating an agent with an unknown connection fails clearly', async () => {
  const res = await authed('POST', '/v1/agents', { ...agentBody, connections: ['nope'] })
  expect(res.statusCode).toBe(422)
  expect(res.json().error.code).toBe('unknown_connection')
})

test('webhooks: returns a hex secret once and validates events', async () => {
  const res = await authed('POST', '/v1/webhooks', { url: 'https://hook.test/in', events: ['run.completed'] })
  expect(res.statusCode).toBe(201)
  const { id, secret } = res.json()
  expect(id).toMatch(/^wh_/)
  expect(secret).toMatch(/^[0-9a-f]{64}$/)
  expect(await new ConfigRepo(pool, 'default').listWebhooks()).toEqual([
    { id, url: 'https://hook.test/in', secret, events: ['run.completed'] },
  ])
  expect((await authed('POST', '/v1/webhooks', { url: 'https://hook.test/in', events: [] })).statusCode).toBe(400)
  expect((await authed('POST', '/v1/webhooks', { url: 'https://hook.test/in', events: ['run.started'] })).statusCode).toBe(400)
})

test('POST /v1/runs creates the run, appends run.created and enqueues', async () => {
  await seedAgent()
  const res = await authed('POST', '/v1/runs', { ...runBody, principal: { id: 'u1', roles: ['staff'] } })
  expect(res.statusCode).toBe(202)
  const { run_id, status } = res.json()
  expect(status).toBe('queued')
  const events = await new PgRunStore(pool, 'default').readEvents(run_id)
  expect(events.map((e) => e.type)).toEqual(['run.created'])
  expect(events[0]?.payload).toMatchObject({ agentId: 'helper', principal: { id: 'u1', roles: ['staff'] } })
  expect(await queueRows(run_id)).toBe(1)
})

test('POST /v1/runs rejects an unknown agent and a bad body', async () => {
  const unknown = await authed('POST', '/v1/runs', runBody)
  expect(unknown.statusCode).toBe(422)
  expect(unknown.json().error.code).toBe('unknown_agent')
  await seedAgent()
  expect((await authed('POST', '/v1/runs', { agent: 'helper', input: { text: '' } })).statusCode).toBe(400)
})

test('repeated Idempotency-Key returns the same run', async () => {
  await seedAgent()
  const a = await authed('POST', '/v1/runs', runBody, { 'idempotency-key': 'k1' })
  const b = await authed('POST', '/v1/runs', runBody, { 'idempotency-key': 'k1' })
  expect(b.json().run_id).toBe(a.json().run_id)
  expect(b.headers['idempotent-replayed']).toBe('true')
  expect(a.headers['idempotent-replayed']).toBeUndefined()
  const events = await new PgRunStore(pool, 'default').readEvents(a.json().run_id)
  expect(events).toHaveLength(1)
})

test('unknown runs give 404 run_not_found on get, events and resolve', async () => {
  for (const [method, path, body] of [
    ['GET', '/v1/runs/ghost', undefined],
    ['GET', '/v1/runs/ghost/events', undefined],
    ['POST', '/v1/runs/ghost/resolve', { action: 'approve' }],
  ] as const) {
    const res = await authed(method, path, body)
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('run_not_found')
  }
})

test('wait validates its value', async () => {
  await seedAgent()
  for (const w of ['0', '31', 'abc', '1.5', '-1', '5m']) {
    const res = await authed('POST', `/v1/runs?wait=${w}`, runBody)
    expect(res.statusCode, w).toBe(400)
    expect(res.json().error.code).toBe('invalid_request')
  }
})

test('wait returns the settled run when a worker finishes it', async () => {
  await seedAgent()
  const llm: LLMPort = {
    complete: async () => ({
      message: { role: 'assistant', content: 'done' },
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: 'end',
    }),
  }
  const worker = startRunWorker({
    pool,
    llm,
    tools: { call: async () => ({ content: '', isError: false }) },
    workerId: 'w1',
    pollMs: 20,
  })
  const res = await authed('POST', '/v1/runs?wait=10s', runBody, { 'idempotency-key': 'w' })
  const replay = await authed('POST', '/v1/runs?wait=5', runBody, { 'idempotency-key': 'w' })
  await worker.stop()
  expect(res.statusCode).toBe(200)
  expect(res.json()).toMatchObject({ agent: 'helper', status: 'completed', output: 'done', pending_approval: null })
  expect(replay.statusCode).toBe(200)
  expect(replay.headers['idempotent-replayed']).toBe('true')
  expect(replay.json().id).toBe(res.json().id)
})

test('wait times out with the current state when nothing runs the job', async () => {
  await seedAgent()
  const started = Date.now()
  const res = await authed('POST', '/v1/runs?wait=1', runBody)
  expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  expect(res.statusCode).toBe(200)
  expect(res.json().status).toBe('queued')
})

test('GET run shows the pending approval, and events report a valid chain', async () => {
  const runId = await runWaitingForApproval()
  const view = (await authed('GET', `/v1/runs/${runId}`)).json()
  expect(view).toEqual({
    id: runId,
    agent: 'helper',
    status: 'waiting_human',
    waiting_reason: 'approval',
    output: null,
    pending_approval: { tool_call_id: 'call_1', tool: 'orders.cancel', args: { id: 7 }, reason: 'write tool' },
  })
  const ev = (await authed('GET', `/v1/runs/${runId}/events`)).json()
  expect(ev.events).toHaveLength(6)
  expect(ev.chain).toEqual({ valid: true })
  await pool.query('ALTER TABLE events DISABLE TRIGGER events_append_only') // tampering needs the trigger off
  await pool.query("UPDATE events SET payload = '{\"tampered\":true}' WHERE run_id = $1 AND seq = 3", [runId])
  const broken = (await authed('GET', `/v1/runs/${runId}/events`)).json()
  expect(broken.chain).toEqual({ valid: false, broken_at_seq: 3 })
})

test('rejects a second resolve with 409', async () => {
  const runId = await runWaitingForApproval()
  const first = await authed('POST', `/v1/runs/${runId}/resolve`, { action: 'approve' })
  expect(first.statusCode).toBe(202)
  expect(first.json()).toEqual({ run_id: runId, status: 'queued' })
  const second = await authed('POST', `/v1/runs/${runId}/resolve`, { action: 'approve' })
  expect(second.statusCode).toBe(409)
  expect(second.json().error.code).toBe('not_waiting_for_approval')
  const types = (await new PgRunStore(pool, 'default').readEvents(runId)).map((e) => e.type)
  expect(types.slice(-2)).toEqual(['approval.resolved', 'run.state_changed'])
  expect(await queueRows(runId)).toBe(1)
})

test('two concurrent resolves: exactly one 202 and one 409', async () => {
  const runId = await runWaitingForApproval()
  const results = await Promise.all([
    authed('POST', `/v1/runs/${runId}/resolve`, { action: 'approve' }),
    authed('POST', `/v1/runs/${runId}/resolve`, { action: 'reject' }),
  ])
  expect(results.map((r) => r.statusCode).sort()).toEqual([202, 409])
  const resolved = (await new PgRunStore(pool, 'default').readEvents(runId)).filter((e) => e.type === 'approval.resolved')
  expect(resolved).toHaveLength(1)
})

test('resolve on a run that is not waiting gives 409', async () => {
  await seedAgent()
  const { run_id } = (await authed('POST', '/v1/runs', runBody)).json()
  const res = await authed('POST', `/v1/runs/${run_id}/resolve`, { action: 'approve' })
  expect(res.statusCode).toBe(409)
  expect(res.json().error.code).toBe('not_waiting_for_approval')
})

test('the settled handler enqueues exactly one delivery per subscribed webhook', async () => {
  const config = new ConfigRepo(pool, 'default')
  await config.putWebhook({ id: 'w1', url: 'https://a.test', secret: 's1', events: ['approval.requested', 'run.completed'] })
  await config.putWebhook({ id: 'w2', url: 'https://b.test', secret: 's2', events: ['approval.requested'] })
  await config.putWebhook({ id: 'w3', url: 'https://c.test', secret: 's3', events: ['run.completed'] })
  const runId = await runWaitingForApproval()
  const settled = createRunSettledHandler(pool)

  await settled(runId, 'waiting_human')
  const rows = await pool.query<{ webhook_id: string; type: string; body: string }>(
    'SELECT webhook_id, type, body FROM webhook_deliveries ORDER BY webhook_id',
  )
  expect(rows.rows.map((r) => [r.webhook_id, r.type])).toEqual([
    ['w1', 'approval.requested'],
    ['w2', 'approval.requested'],
  ])
  const body = JSON.parse(rows.rows[0]!.body)
  expect(body.type).toBe('approval.requested')
  expect(body.data).toEqual({
    run_id: runId,
    agent: 'helper',
    status: 'waiting_human',
    waiting_reason: 'approval',
    output: null,
    pending_approval: { tool_call_id: 'call_1', tool: 'orders.cancel', args: { id: 7 }, reason: 'write tool' },
  })

  // other statuses and non-approval waits queue nothing
  await settled(runId, 'running')
  expect((await pool.query('SELECT 1 FROM webhook_deliveries')).rowCount).toBe(2)
})

test('auth cannot be bypassed with an encoded path', async () => {
  for (const [method, path] of [
    ['GET', '/%761/runs/x'],
    ['POST', '/%761/agents'],
    ['GET', '/v1/runs/x'],
  ] as const) {
    const res = await app.inject({ method, url: path, payload: method === 'POST' ? agentBody : undefined })
    expect([401, 404], path).toContain(res.statusCode)
    expect(res.json().error.code, path).not.toBe('run_not_found')
    expect(res.statusCode === 401 || res.json().error.code === 'not_found', path).toBe(true)
  }
  const unknown = await authed('GET', '/v1/nope')
  expect(unknown.statusCode).toBe(404)
  expect(unknown.json().error.code).toBe('not_found')
})

test('closing the app ends a pending wait quickly', async () => {
  await seedAgent()
  const pending = authed('POST', '/v1/runs?wait=30', runBody)
  await new Promise((r) => setTimeout(r, 300))
  const started = Date.now()
  await app.close()
  expect(Date.now() - started).toBeLessThan(2000)
  expect((await pending).statusCode).toBe(200)
})

test('a replayed Idempotency-Key appends nothing and enqueues nothing', async () => {
  await seedAgent()
  const a = await authed('POST', '/v1/runs', runBody, { 'idempotency-key': 'k2' })
  await authed('POST', '/v1/runs', runBody, { 'idempotency-key': 'k2' })
  const id = a.json().run_id
  expect(await new PgRunStore(pool, 'default').readEvents(id)).toHaveLength(1)
  expect(await queueRows(id)).toBe(1)
})

test('concurrent POSTs with one Idempotency-Key create one run', async () => {
  await seedAgent()
  const res = await Promise.all([
    authed('POST', '/v1/runs', runBody, { 'idempotency-key': 'k3' }),
    authed('POST', '/v1/runs', runBody, { 'idempotency-key': 'k3' }),
  ])
  const ids = res.map((r) => r.json().run_id)
  expect(ids[0]).toBe(ids[1])
  expect(res.filter((r) => r.headers['idempotent-replayed'] === undefined)).toHaveLength(1)
  const created = (await new PgRunStore(pool, 'default').readEvents(ids[0])).filter((e) => e.type === 'run.created')
  expect(created).toHaveLength(1)
})

test('connection responses never contain url credentials', async () => {
  const ok = await authed('POST', '/v1/connections', { id: 'shop', url: 'http://user:pass@host.test/mcp' })
  expect(ok.statusCode).toBe(201)
  expect(ok.body).not.toContain('pass')
  const failing = buildApp({
    pool,
    adminKey: ADMIN_KEY,
    discoverTools: async () => {
      throw new Error('connection_unreachable: http://user:pass@host.test/mcp')
    },
  })
  const bad = await failing.inject({
    method: 'POST',
    url: '/v1/connections',
    payload: { id: 'x', url: 'http://user:pass@host.test/mcp' },
    headers: { authorization: `Bearer ${ADMIN_KEY}` },
  })
  expect(bad.statusCode).toBe(422)
  expect(bad.body).not.toContain('pass')
})

test('webhook events are deduplicated', async () => {
  const res = await authed('POST', '/v1/webhooks', { url: 'https://h.test/in', events: ['run.failed', 'run.failed'] })
  expect(res.statusCode).toBe(201)
  expect((await new ConfigRepo(pool, 'default').listWebhooks())[0]?.events).toEqual(['run.failed'])
})

test('POST /v1/runs labels run.created as untrusted caller input', async () => {
  await seedAgent()
  const id = (await authed('POST', '/v1/runs', runBody)).json().run_id
  const events = await new PgRunStore(pool, 'default').readEvents(id)
  expect(events[0]).toMatchObject({ type: 'run.created', labels: ['untrusted'] })
})

test('events report an invalid chain when tail events were deleted', async () => {
  const runId = await runWaitingForApproval()
  // The append-only trigger would block the delete, so it is disabled for this test only.
  await pool.query('ALTER TABLE events DISABLE TRIGGER events_append_only')
  await pool.query('DELETE FROM events WHERE run_id = $1 AND seq > 4', [runId])
  const res = (await authed('GET', `/v1/runs/${runId}/events`)).json()
  expect(res.events).toHaveLength(4)
  expect(res.chain).toEqual({ valid: false, broken_at_seq: 5 })
})

test('a run without events reports a valid chain; deleting all events does not', async () => {
  await seedAgent()
  await createRun(pool, { tenantId: 'default', runId: 'r-empty', agentId: 'helper', agentVersion: 1, input: { text: 'hi' } })
  expect((await authed('GET', '/v1/runs/r-empty/events')).json().chain).toEqual({ valid: true })
  const runId = await runWaitingForApproval()
  await pool.query('ALTER TABLE events DISABLE TRIGGER events_append_only')
  await pool.query('DELETE FROM events WHERE run_id = $1', [runId])
  expect((await authed('GET', `/v1/runs/${runId}/events`)).json().chain).toEqual({ valid: false, broken_at_seq: 1 })
})

test('settling the same run state twice queues one delivery per webhook', async () => {
  await new ConfigRepo(pool, 'default').putWebhook({ id: 'w1', url: 'https://a.test', secret: 's1', events: ['approval.requested'] })
  const runId = await runWaitingForApproval()
  const settled = createRunSettledHandler(pool)
  await settled(runId, 'waiting_human')
  await settled(runId, 'waiting_human')
  const rows = await pool.query<{ event_id: string }>('SELECT event_id FROM webhook_deliveries')
  expect(rows.rows.map((r) => r.event_id)).toEqual([`evt_${runId}_6_approval.requested`])
})

test('events appended after the head was read do not make the chain invalid', async () => {
  const runId = await runWaitingForApproval()
  const store = new PgRunStore(pool, 'default')
  const head = await getRunHead(pool, 'default', runId)
  await store.append(runId, [{ type: 'llm.requested', payload: { model: 'm' }, labels: [] }])
  const events = await store.readEvents(runId)
  expect(events.length).toBeGreaterThan(head!.lastSeq!)
  expect(checkChain(events, head)).toEqual({ valid: true })
})

test('after tail deletion, append is refused and the events route still reports an invalid chain', async () => {
  const runId = await runWaitingForApproval()
  await pool.query('ALTER TABLE events DISABLE TRIGGER events_append_only')
  await pool.query('DELETE FROM events WHERE run_id = $1 AND seq > 4', [runId])
  await expect(
    new PgRunStore(pool, 'default').append(runId, [{ type: 'llm.requested', payload: { model: 'm' }, labels: [] }]),
  ).rejects.toThrow(/log head/)
  expect((await authed('GET', `/v1/runs/${runId}/events`)).json().chain).toEqual({ valid: false, broken_at_seq: 5 })
})
