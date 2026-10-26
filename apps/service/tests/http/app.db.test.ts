import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { toolFingerprint } from '@agent-core/core'
import type { LLMPort, NewEvent, ToolDescriptor } from '@agent-core/core'
import { ConfigRepo, PgRunStore, assertTestDatabase, createPool, runtimeTestUrl, createRun, createTenant, getRunHead, runMigrations } from '@agent-core/store-postgres'
import { buildApp } from '../../src/http/app'
import { checkChain } from '../../src/http/routes/runs'
import { createRunSettledHandler } from '../../src/runs/settled'
import { startRunWorker } from '../../src/worker/worker'
import { createSecretBox } from '@agent-core/core'

const box = createSecretBox(Buffer.alloc(32, 7))
const url = process.env.TEST_DATABASE_URL ?? 'postgres://agentcore:agentcore@localhost:5433/agentcore_test'
const ADMIN_KEY = 'test-admin-key'
let migrator: ReturnType<typeof createPool>
let pool: ReturnType<typeof createPool>
let app: FastifyInstance

const readTool: ToolDescriptor = {
  name: 'orders.get',
  description: 'get an order',
  inputSchema: {},
  safety: { effect: 'read', idempotency: false, reachesOutside: false, outputLabel: 'untrusted' },
  connectionId: 'shop',
}
const readSource = { annotations: { readOnlyHint: true, openWorldHint: false } }
const readProposal = { effect: 'read', idempotency: false, reachesOutside: false, outputLabel: 'internal' }
const strict = { effect: 'write', idempotency: false, reachesOutside: true, outputLabel: 'untrusted' }
const discoverTools = async (connectionId: string) => [
  { tool: { ...readTool, safety: strict as ToolDescriptor['safety'], connectionId }, source: readSource },
]
const readFingerprint = toolFingerprint({ ...readTool, source: readSource })
const fresh = { description: readTool.description, inputSchema: readTool.inputSchema, fingerprint: readFingerprint, changedSinceReview: false }

beforeAll(() => {
  assertTestDatabase(url)
  migrator = createPool(url)
  pool = createPool(runtimeTestUrl(url))
})
beforeEach(async () => {
  await migrator.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(migrator, { runtimeUser: 'agentcore_runtime' })
  app = buildApp({ secrets: box, pool, adminKey: ADMIN_KEY, discoverTools })
})
afterAll(async () => {
  await pool.end()
  await migrator.end()
})

const agentBody = { id: 'helper', instructions: 'help', connections: [] as string[], autonomy: 'supervised', allow: [] }
const runBody = { agent: 'helper', input: { text: 'hi' } }

function authed(method: 'GET' | 'POST' | 'PATCH', path: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method,
    url: path,
    payload: payload as object | undefined,
    headers: { authorization: `Bearer ${ADMIN_KEY}`, ...headers },
  })
}

const seedAgent = () => new ConfigRepo(pool, 'default', box).putAgent({ ...agentBody, autonomy: 'supervised', model: 'default' })

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

async function runWaitingForOutcome(runId = 'r-out', reason: string | null = 'The tool call failed after it was sent (tool_call_failed: HTTP 503). It may have run.'): Promise<string> {
  const { version } = await seedAgent()
  await createRun(pool, { tenantId: 'default', runId, agentId: 'helper', agentVersion: version, input: { text: 'hi' } })
  const events: NewEvent[] = [
    { type: 'run.created', payload: { agentId: 'helper', input: { text: 'hi' } }, labels: ['trusted'] },
    { type: 'run.state_changed', payload: { from: 'queued', to: 'running' }, labels: [] },
    {
      type: 'llm.responded',
      payload: {
        message: { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'payments.refund', arguments: { amount: 5 } }] },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'tool_calls',
      },
      labels: [],
    },
    {
      type: 'tool.requested',
      payload: { toolCallId: 'call_1', tool: 'payments.refund', args: { amount: 5 }, idempotencyKey: 'key_1' },
      labels: [],
    },
    ...(reason === null ? [] : [{ type: 'error.raised' as const, payload: { message: reason, retryable: false }, labels: [] }]),
    { type: 'run.state_changed', payload: { from: 'running', to: 'waiting_human', reason: 'unknown_outcome' }, labels: [] },
  ]
  await new PgRunStore(pool, 'default').append(runId, events)
  return runId
}

async function runWaitingFor(reason: 'breaker' | 'handoff' | 'needs_input' | 'limit', runId = 'r-other', before: NewEvent[] = []): Promise<string> {
  const { version } = await seedAgent()
  await createRun(pool, { tenantId: 'default', runId, agentId: 'helper', agentVersion: version, input: { text: 'hi' } })
  await new PgRunStore(pool, 'default').append(runId, [
    { type: 'run.created', payload: { agentId: 'helper', input: { text: 'hi' } }, labels: ['trusted'] },
    { type: 'run.state_changed', payload: { from: 'queued', to: 'running' }, labels: [] },
    ...before,
    { type: 'run.state_changed', payload: { from: 'running', to: 'waiting_human', reason }, labels: [] },
  ])
  return runId
}

const eventTypes = async (runId: string) => (await new PgRunStore(pool, 'default').readEvents(runId)).map((e) => e.type)

const queueRows = async (runId: string) => (await migrator.query('SELECT 1 FROM queue WHERE run_id = $1', [runId])).rowCount

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
  const res = await buildApp({ secrets: box, pool: dead, adminKey: ADMIN_KEY }).inject({ method: 'GET', url: '/healthz' })
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

test('creating a connection stores the discovered tools and proposes their safety', async () => {
  const res = await authed('POST', '/v1/connections', { id: 'shop', url: 'http://shop.test/mcp' })
  expect(res.statusCode).toBe(201)
  expect(res.json()).toEqual({
    id: 'shop',
    kind: 'mcp',
    tools: [
      { name: 'orders.get', safety: strict, proposed: readProposal, needsConfirmation: ['effect', 'reachesOutside', 'outputLabel'], ...fresh },
    ],
  })
  const stored = await new ConfigRepo(pool, 'default', box).getConnection('shop')
  expect(stored?.tools[0]).toMatchObject({ connectionId: 'shop', source: readSource, confirmed: {} })
  // an existing id is overwritten
  expect((await authed('POST', '/v1/connections', { id: 'shop', url: 'http://shop2.test/mcp' })).statusCode).toBe(201)
  expect((await new ConfigRepo(pool, 'default', box).getConnection('shop'))?.url).toBe('http://shop2.test/mcp')
})

test('GET tools lists the views; an unknown connection gives 404', async () => {
  await authed('POST', '/v1/connections', { id: 'shop', url: 'http://shop.test/mcp' })
  const res = await authed('GET', '/v1/connections/shop/tools')
  expect(res.statusCode).toBe(200)
  expect(res.json().tools).toEqual([
    { name: 'orders.get', safety: strict, proposed: readProposal, needsConfirmation: ['effect', 'reachesOutside', 'outputLabel'], ...fresh },
  ])
  const missing = await authed('GET', '/v1/connections/nope/tools')
  expect(missing.statusCode).toBe(404)
  expect(missing.json().error).toMatchObject({ code: 'connection_not_found', fix: expect.any(String) })
})

test('PATCH confirms the whole proposal', async () => {
  await authed('POST', '/v1/connections', { id: 'shop', url: 'http://shop.test/mcp' })
  const res = await authed('PATCH', '/v1/connections/shop/tools/orders.get', { confirm: 'proposed' })
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({ name: 'orders.get', safety: readProposal, proposed: readProposal, needsConfirmation: [], ...fresh })
  const stored = await new ConfigRepo(pool, 'default', box).getConnection('shop')
  expect(stored?.tools[0]).toMatchObject({ safety: readProposal, confirmed: readProposal, reviewedFor: readFingerprint })
})

test('PATCH with explicit values confirms only those keys and merges', async () => {
  await authed('POST', '/v1/connections', { id: 'shop', url: 'http://shop.test/mcp' })
  const first = await authed('PATCH', '/v1/connections/shop/tools/orders.get', { effect: 'read' })
  expect(first.json()).toMatchObject({ safety: { ...strict, effect: 'read' }, needsConfirmation: ['reachesOutside', 'outputLabel'] })
  const second = await authed('PATCH', '/v1/connections/shop/tools/orders.get', { reachesOutside: false, outputLabel: 'internal' })
  expect(second.json()).toMatchObject({ safety: readProposal, needsConfirmation: [] })
})

test('PATCH errors: unknown tool or connection 404, empty or unknown body 400', async () => {
  await authed('POST', '/v1/connections', { id: 'shop', url: 'http://shop.test/mcp' })
  const tool = await authed('PATCH', '/v1/connections/shop/tools/nope', { confirm: 'proposed' })
  expect(tool.statusCode).toBe(404)
  expect(tool.json().error).toMatchObject({ code: 'tool_not_found', fix: expect.any(String) })
  const conn = await authed('PATCH', '/v1/connections/nope/tools/orders.get', { confirm: 'proposed' })
  expect(conn.statusCode).toBe(404)
  expect(conn.json().error.code).toBe('connection_not_found')
  for (const body of [
    {},
    { confirm: 'other' },
    { effect: 'maybe' },
    { bogus: true },
    { confirm: 'proposed', effect: 'read' },
    { fingerprint: readFingerprint },
    { confirm: 'proposed', fingerprint: 'abc' },
  ]) {
    const bad = await authed('PATCH', '/v1/connections/shop/tools/orders.get', body)
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error.code).toBe('invalid_request')
  }
  const stored = await new ConfigRepo(pool, 'default', box).getConnection('shop')
  expect(stored?.tools[0]?.confirmed).toEqual({})
})

test('a PATCH error names the fields to send', async () => {
  await authed('POST', '/v1/connections', { id: 'shop', url: 'http://shop.test/mcp' })
  const res = await authed('PATCH', '/v1/connections/shop/tools/orders.get', {})
  expect(res.json().error.message).toBe(
    'body: set either "confirm": "proposed" or at least one of effect, idempotency, reachesOutside, outputLabel',
  )
})

/** An app whose MCP server now describes `orders.get` differently. */
const changedApp = (change: Partial<ToolDescriptor>) =>
  buildApp({
    secrets: box,
    pool,
    adminKey: ADMIN_KEY,
    discoverTools: async (id: string) => (await discoverTools(id)).map((d) => ({ ...d, tool: { ...d.tool, ...change } })),
  })
const register = (a: FastifyInstance) =>
  a.inject({ method: 'POST', url: '/v1/connections', payload: { id: 'shop', url: 'http://shop.test/mcp' }, headers: { authorization: `Bearer ${ADMIN_KEY}` } })

test('a tool whose definition changed loses its confirmation and runs strict until confirmed again', async () => {
  await authed('POST', '/v1/connections', { id: 'shop', url: 'http://shop.test/mcp' })
  await authed('PATCH', '/v1/connections/shop/tools/orders.get', { confirm: 'proposed' })

  const res = await register(changedApp({ description: 'get an order; also refunds it' }))
  expect(res.json().tools[0]).toMatchObject({ safety: strict, changedSinceReview: true, needsConfirmation: ['effect', 'reachesOutside', 'outputLabel'] })
  const newFingerprint = res.json().tools[0].fingerprint as string
  // The admin sees what changed before confirming again.
  expect(res.json().tools[0].description).toBe('get an order; also refunds it')
  expect(newFingerprint).not.toBe(readFingerprint)
  // What the worker loads runs strict too.
  expect((await new ConfigRepo(pool, 'default', box).getConnection('shop'))?.tools[0]?.safety).toEqual(strict)

  // Confirming one key does not bring back the keys confirmed for the old definition.
  const one = await authed('PATCH', '/v1/connections/shop/tools/orders.get', { effect: 'read', fingerprint: newFingerprint })
  expect(one.json()).toMatchObject({ safety: { ...strict, effect: 'read' }, changedSinceReview: false, fingerprint: newFingerprint })
})

test('an unchanged tool keeps its confirmation when registered again', async () => {
  await authed('POST', '/v1/connections', { id: 'shop', url: 'http://shop.test/mcp' })
  await authed('PATCH', '/v1/connections/shop/tools/orders.get', { confirm: 'proposed' })
  const again = await authed('POST', '/v1/connections', { id: 'shop', url: 'http://shop.test/mcp' })
  expect(again.json().tools[0]).toMatchObject({ safety: readProposal, ...fresh })
})

test('PATCH with an old fingerprint gives 409 tool_changed and confirms nothing', async () => {
  await authed('POST', '/v1/connections', { id: 'shop', url: 'http://shop.test/mcp' })
  await register(changedApp({ inputSchema: { type: 'object', properties: { order_id: { type: 'string' } } } }))
  const res = await authed('PATCH', '/v1/connections/shop/tools/orders.get', { confirm: 'proposed', fingerprint: readFingerprint })
  expect(res.statusCode).toBe(409)
  expect(res.json().error).toMatchObject({ code: 'tool_changed', fix: expect.stringContaining('GET /v1/connections/{id}/tools') })
  const stored = await new ConfigRepo(pool, 'default', box).getConnection('shop')
  expect(stored?.tools[0]).toMatchObject({ confirmed: {}, safety: strict })
})

test('registering a connection at a different URL drops every confirmation: it is another server', async () => {
  await authed('POST', '/v1/connections', { id: 'shop', url: 'http://shop.test/mcp' })
  await authed('PATCH', '/v1/connections/shop/tools/orders.get', { confirm: 'proposed' })
  const again = await authed('POST', '/v1/connections', { id: 'shop', url: 'http://shop2.test/mcp' })
  expect(again.json().tools[0]).toMatchObject({ safety: strict, changedSinceReview: true })
  const stored = await new ConfigRepo(pool, 'default', box).getConnection('shop')
  expect(stored?.tools[0]).toMatchObject({ confirmed: {}, safety: strict, changedSinceReview: true })
})

test('a tool added when a connection is registered again waits for review', async () => {
  await authed('POST', '/v1/connections', { id: 'shop', url: 'http://shop.test/mcp' })
  const renamed = buildApp({
    secrets: box,
    pool,
    adminKey: ADMIN_KEY,
    discoverTools: async (id: string) => (await discoverTools(id)).map((d) => ({ ...d, tool: { ...d.tool, name: 'orders.list' } })),
  })
  const res = await renamed.inject({
    method: 'POST',
    url: '/v1/connections',
    payload: { id: 'shop', url: 'http://shop.test/mcp' },
    headers: { authorization: `Bearer ${ADMIN_KEY}` },
  })
  expect(res.json().tools[0]).toMatchObject({ name: 'orders.list', safety: strict, changedSinceReview: true })
})

test('confirming a changed tool needs the fingerprint the admin reviewed', async () => {
  await authed('POST', '/v1/connections', { id: 'shop', url: 'http://shop.test/mcp' })
  const res = await register(changedApp({ description: 'get an order; also refunds it' }))
  const fingerprint = res.json().tools[0].fingerprint as string
  const blind = await authed('PATCH', '/v1/connections/shop/tools/orders.get', { confirm: 'proposed' })
  expect(blind.statusCode).toBe(428)
  expect(blind.json().error).toMatchObject({ code: 'fingerprint_required', fix: expect.stringContaining('GET /v1/connections/{id}/tools') })
  expect((await new ConfigRepo(pool, 'default', box).getConnection('shop'))?.tools[0]).toMatchObject({ confirmed: {}, changedSinceReview: true })
  const seen = await authed('PATCH', '/v1/connections/shop/tools/orders.get', { confirm: 'proposed', fingerprint })
  expect(seen.json()).toMatchObject({ changedSinceReview: false, fingerprint })
})

test('registering an MCP connection over a webhook connection gives 409', async () => {
  await new ConfigRepo(pool, 'default', box).putConnection({ id: 'hook', kind: 'webhook', url: 'http://h/x', secret: 's', tools: [] })
  const res = await authed('POST', '/v1/connections', { id: 'hook', url: 'http://shop.test/mcp' })
  expect(res.statusCode).toBe(409)
  expect(res.json().error).toMatchObject({ code: 'connection_kind_conflict', fix: expect.any(String) })
  expect((await new ConfigRepo(pool, 'default', box).getConnection('hook'))?.kind).toBe('webhook')
})

test('an unreachable connection gives 422 and a non-http url gives 400', async () => {
  const failing = buildApp({
    secrets: box,
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
  expect(await new ConfigRepo(pool, 'default', box).listWebhooks()).toEqual([
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
    ['POST', '/v1/runs/ghost/input', { action: 'approve' }],
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
    secrets: box,
    pool,
    llm,
    tools: () => ({ call: async () => ({ content: '', isError: false }) }),
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
    pending_outcome: null,
  })
  const ev = (await authed('GET', `/v1/runs/${runId}/events`)).json()
  expect(ev.events).toHaveLength(6)
  expect(ev.chain).toEqual({ valid: true })
  await migrator.query('ALTER TABLE events DISABLE TRIGGER events_append_only') // tampering needs the trigger off
  await migrator.query("UPDATE events SET payload = '{\"tampered\":true}' WHERE run_id = $1 AND seq = 3", [runId])
  const broken = (await authed('GET', `/v1/runs/${runId}/events`)).json()
  expect(broken.chain).toEqual({ valid: false, broken_at_seq: 3 })
})

test('rejects a second resolve with 409', async () => {
  const runId = await runWaitingForApproval()
  const first = await authed('POST', `/v1/runs/${runId}/input`, { action: 'approve' })
  expect(first.statusCode).toBe(202)
  expect(first.json()).toEqual({ run_id: runId, status: 'queued' })
  const second = await authed('POST', `/v1/runs/${runId}/input`, { action: 'approve' })
  expect(second.statusCode).toBe(409)
  expect(second.json().error.code).toBe('not_waiting_for_approval')
  const types = (await new PgRunStore(pool, 'default').readEvents(runId)).map((e) => e.type)
  expect(types.slice(-2)).toEqual(['approval.resolved', 'run.state_changed'])
  expect(await queueRows(runId)).toBe(1)
})

test('two concurrent resolves: exactly one 202 and one 409', async () => {
  const runId = await runWaitingForApproval()
  const results = await Promise.all([
    authed('POST', `/v1/runs/${runId}/input`, { action: 'approve' }),
    authed('POST', `/v1/runs/${runId}/input`, { action: 'reject' }),
  ])
  expect(results.map((r) => r.statusCode).sort()).toEqual([202, 409])
  const resolved = (await new PgRunStore(pool, 'default').readEvents(runId)).filter((e) => e.type === 'approval.resolved')
  expect(resolved).toHaveLength(1)
})

test('resolve on a run that is not waiting gives 409', async () => {
  await seedAgent()
  const { run_id } = (await authed('POST', '/v1/runs', runBody)).json()
  const res = await authed('POST', `/v1/runs/${run_id}/input`, { action: 'approve' })
  expect(res.statusCode).toBe(409)
  expect(res.json().error.code).toBe('not_waiting_for_approval')
})

test('the settled handler enqueues exactly one delivery per subscribed webhook', async () => {
  const config = new ConfigRepo(pool, 'default', box)
  await config.putWebhook({ id: 'w1', url: 'https://a.test', secret: 's1', events: ['approval.requested', 'run.completed'] })
  await config.putWebhook({ id: 'w2', url: 'https://b.test', secret: 's2', events: ['approval.requested'] })
  await config.putWebhook({ id: 'w3', url: 'https://c.test', secret: 's3', events: ['run.completed'] })
  const runId = await runWaitingForApproval()
  const settled = createRunSettledHandler(pool)

  await settled(runId, 'default', 'waiting_human')
  const rows = await migrator.query<{ webhook_id: string; type: string; body: string }>(
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
    pending_outcome: null,
  })

  // other statuses and non-approval waits queue nothing
  await settled(runId, 'default', 'running')
  expect((await migrator.query('SELECT 1 FROM webhook_deliveries')).rowCount).toBe(2)
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
    secrets: box,
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
  expect((await new ConfigRepo(pool, 'default', box).listWebhooks())[0]?.events).toEqual(['run.failed'])
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
  await migrator.query('ALTER TABLE events DISABLE TRIGGER events_append_only')
  await migrator.query('DELETE FROM events WHERE run_id = $1 AND seq > 4', [runId])
  const res = (await authed('GET', `/v1/runs/${runId}/events`)).json()
  expect(res.events).toHaveLength(4)
  expect(res.chain).toEqual({ valid: false, broken_at_seq: 5 })
})

test('a run without events reports a valid chain; deleting all events does not', async () => {
  await seedAgent()
  await createRun(pool, { tenantId: 'default', runId: 'r-empty', agentId: 'helper', agentVersion: 1, input: { text: 'hi' } })
  expect((await authed('GET', '/v1/runs/r-empty/events')).json().chain).toEqual({ valid: true })
  const runId = await runWaitingForApproval()
  await migrator.query('ALTER TABLE events DISABLE TRIGGER events_append_only')
  await migrator.query('DELETE FROM events WHERE run_id = $1', [runId])
  expect((await authed('GET', `/v1/runs/${runId}/events`)).json().chain).toEqual({ valid: false, broken_at_seq: 1 })
})

test('settling the same run state twice queues one delivery per webhook', async () => {
  await new ConfigRepo(pool, 'default', box).putWebhook({ id: 'w1', url: 'https://a.test', secret: 's1', events: ['approval.requested'] })
  const runId = await runWaitingForApproval()
  const settled = createRunSettledHandler(pool)
  await settled(runId, 'default', 'waiting_human')
  await settled(runId, 'default', 'waiting_human')
  const rows = await migrator.query<{ event_id: string }>('SELECT event_id FROM webhook_deliveries')
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
  await migrator.query('ALTER TABLE events DISABLE TRIGGER events_append_only')
  await migrator.query('DELETE FROM events WHERE run_id = $1 AND seq > 4', [runId])
  await expect(
    new PgRunStore(pool, 'default').append(runId, [{ type: 'llm.requested', payload: { model: 'm' }, labels: [] }]),
  ).rejects.toThrow(/log head/)
  expect((await authed('GET', `/v1/runs/${runId}/events`)).json().chain).toEqual({ valid: false, broken_at_seq: 5 })
})

const webhookTool = {
  name: 'loyalty.points_add',
  description: 'add loyalty points',
  inputSchema: { type: 'object', properties: { points: { type: 'number' } } },
  safety: { effect: 'write', idempotency: true, reachesOutside: false, outputLabel: 'internal' },
  supports: ['principal', 'idempotency-key'],
}
const webhookBody = { id: 'loyalty', kind: 'webhook', url: 'http://loyalty.test/tools', tools: [webhookTool] }

test('registering a webhook connection stores confirmed tools and returns the secret once', async () => {
  const res = await authed('POST', '/v1/connections', webhookBody)
  expect(res.statusCode).toBe(201)
  const { secret, ...rest } = res.json()
  expect(secret).toMatch(/^[0-9a-f]{64}$/)
  expect(rest).toMatchObject({ id: 'loyalty', kind: 'webhook' })
  expect(rest.tools[0]).toMatchObject({ name: 'loyalty.points_add', safety: webhookTool.safety, needsConfirmation: [] })
  const stored = await new ConfigRepo(pool, 'default', box).getConnection('loyalty')
  expect(stored).toMatchObject({ kind: 'webhook', url: webhookBody.url, secret })
  expect(stored?.tools[0]).toMatchObject({
    connectionId: 'loyalty',
    supports: webhookTool.supports,
    source: { declared: webhookTool.safety, supports: webhookTool.supports },
    confirmed: webhookTool.safety,
    changedSinceReview: false,
  })
  expect(stored?.tools[0]?.reviewedFor).toBe(stored?.tools[0]?.fingerprint)

  const again = await authed('POST', '/v1/connections', { ...webhookBody, url: 'http://loyalty2.test/tools' })
  expect(again.statusCode).toBe(201)
  expect(again.json()).not.toHaveProperty('secret')
  expect(await new ConfigRepo(pool, 'default', box).getConnection('loyalty')).toMatchObject({ url: 'http://loyalty2.test/tools', secret })
})

test('registering a webhook connection over an MCP connection gives 409', async () => {
  await authed('POST', '/v1/connections', { id: 'shop', url: 'http://shop.test/mcp' })
  const res = await authed('POST', '/v1/connections', { ...webhookBody, id: 'shop' })
  expect(res.statusCode).toBe(409)
  expect(res.json().error).toMatchObject({ code: 'connection_kind_conflict', fix: expect.any(String) })
  expect((await new ConfigRepo(pool, 'default', box).getConnection('shop'))?.kind).toBe('mcp')
})

test('webhook connection validation gives 400', async () => {
  const bad: unknown[] = [
    { ...webhookBody, tools: [] },
    { ...webhookBody, tools: [webhookTool, webhookTool] },
    { ...webhookBody, tools: [{ ...webhookTool, name: 'Bad Name' }] },
    { ...webhookBody, tools: [{ ...webhookTool, inputSchema: 'x' }] },
    { ...webhookBody, tools: [{ ...webhookTool, safety: { effect: 'write' } }] },
    { ...webhookBody, tools: [{ ...webhookTool, supports: ['teleport'] }] },
    { ...webhookBody, url: 'ftp://x' },
    { ...webhookBody, tools: Array.from({ length: 101 }, (_, i) => ({ ...webhookTool, name: `t${i}` })) },
  ]
  for (const body of bad) {
    const res = await authed('POST', '/v1/connections', body)
    expect(res.statusCode, JSON.stringify(body).slice(0, 80)).toBe(400)
  }
  expect(await new ConfigRepo(pool, 'default', box).getConnection('loyalty')).toBeNull()
})

test('GET run shows the pending outcome of an unknown_outcome wait', async () => {
  const runId = await runWaitingForOutcome()
  const view = (await authed('GET', `/v1/runs/${runId}`)).json()
  expect(view).toMatchObject({
    status: 'waiting_human',
    waiting_reason: 'unknown_outcome',
    pending_approval: null,
    pending_outcome: {
      tool_call_id: 'call_1',
      tool: 'payments.refund',
      args: { amount: 5 },
      reason: 'The tool call failed after it was sent (tool_call_failed: HTTP 503). It may have run.',
    },
  })
})

test('a pending outcome logged without a reason shows reason null', async () => {
  const runId = await runWaitingForOutcome('r-out-old', null)
  expect((await authed('GET', `/v1/runs/${runId}`)).json().pending_outcome).toEqual({
    tool_call_id: 'call_1',
    tool: 'payments.refund',
    args: { amount: 5 },
    reason: null,
  })
})

test('outcome_happened settles the call, answers the model, and enqueues', async () => {
  const runId = await runWaitingForOutcome()
  const res = await authed('POST', `/v1/runs/${runId}/input`, { action: 'outcome_happened' })
  expect(res.statusCode).toBe(202)
  expect(res.json()).toEqual({ run_id: runId, status: 'queued' })
  const events = await new PgRunStore(pool, 'default').readEvents(runId)
  expect(events.slice(-3).map((e) => e.type)).toEqual(['outcome.settled', 'tool.responded', 'run.state_changed'])
  expect(events.at(-3)!.payload).toEqual({ toolCallId: 'call_1', outcome: 'happened' })
  expect(events.at(-2)).toMatchObject({
    payload: { toolCallId: 'call_1', content: 'A human confirmed that this action happened. Its result is not available.', isError: false },
    labels: ['trusted'],
  })
  expect(events.at(-1)!.payload).toEqual({ from: 'waiting_human', to: 'running' })
  expect((await authed('GET', `/v1/runs/${runId}`)).json()).toMatchObject({ status: 'running', pending_outcome: null })
  expect(await queueRows(runId)).toBe(1)
})

test('outcome_not_happened settles the call and enqueues without answering the model', async () => {
  const runId = await runWaitingForOutcome()
  const res = await authed('POST', `/v1/runs/${runId}/input`, { action: 'outcome_not_happened' })
  expect(res.statusCode).toBe(202)
  const events = await new PgRunStore(pool, 'default').readEvents(runId)
  expect(events.slice(-2).map((e) => e.type)).toEqual(['outcome.settled', 'run.state_changed'])
  expect(events.at(-2)!.payload).toEqual({ toolCallId: 'call_1', outcome: 'not_happened' })
  expect(await queueRows(runId)).toBe(1)
})

test('cancel through resolve ends a run waiting for any reason', async () => {
  const ids = [
    await runWaitingForApproval('r-a'),
    await runWaitingForOutcome('r-o'),
    await runWaitingFor('breaker', 'r-b'),
    await runWaitingFor('handoff', 'r-h'),
    await runWaitingFor('needs_input', 'r-n'),
  ]
  for (const id of ids) {
    const res = await authed('POST', `/v1/runs/${id}/input`, { action: 'cancel' })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ run_id: id, status: 'cancelled' })
    expect((await authed('GET', `/v1/runs/${id}`)).json().status).toBe('cancelled')
    expect((await eventTypes(id)).at(-1)).toBe('run.state_changed')
    expect(await queueRows(id)).toBe(0)
  }
})

test('an action that does not fit the waiting reason gives 409 action_not_allowed with the allowed actions', async () => {
  const approvalRun = await runWaitingForApproval('r-a')
  const outcomeRun = await runWaitingForOutcome('r-o')
  const breakerRun = await runWaitingFor('breaker', 'r-b')
  const cases: [string, string, string[]][] = [
    [approvalRun, 'outcome_happened', ['approve', 'reject', 'cancel']],
    [approvalRun, 'outcome_not_happened', ['approve', 'reject', 'cancel']],
    [outcomeRun, 'approve', ['outcome_happened', 'outcome_not_happened', 'cancel']],
    [outcomeRun, 'reject', ['outcome_happened', 'outcome_not_happened', 'cancel']],
    [breakerRun, 'approve', ['continue', 'cancel']],
    [breakerRun, 'outcome_happened', ['continue', 'cancel']],
    [approvalRun, 'continue', ['approve', 'reject', 'cancel']],
    [outcomeRun, 'continue', ['outcome_happened', 'outcome_not_happened', 'cancel']],
  ]
  for (const [id, action, allowed] of cases) {
    const before = (await eventTypes(id)).length
    const res = await authed('POST', `/v1/runs/${id}/input`, { action })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('action_not_allowed')
    for (const a of allowed) expect(res.json().error.fix).toContain(a)
    expect((await eventTypes(id)).length).toBe(before)
  }
})

// cancel is left out: it also cancels a run that is not waiting.
test('an outcome action on a run that is not waiting gives 409 not_waiting_human', async () => {
  await seedAgent()
  const { run_id } = (await authed('POST', '/v1/runs', runBody)).json()
  for (const action of ['outcome_happened', 'outcome_not_happened']) {
    const res = await authed('POST', `/v1/runs/${run_id}/input`, { action })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('not_waiting_human')
  }
})

test('resolve rejects an unknown action with 400', async () => {
  const runId = await runWaitingForOutcome()
  expect((await authed('POST', `/v1/runs/${runId}/input`, { action: 'resume' })).statusCode).toBe(400)
})

test('concurrent outcome resolves: exactly one wins', async () => {
  const runId = await runWaitingForOutcome()
  const results = await Promise.all([
    authed('POST', `/v1/runs/${runId}/input`, { action: 'outcome_happened' }),
    authed('POST', `/v1/runs/${runId}/input`, { action: 'outcome_not_happened' }),
  ])
  expect(results.map((r) => r.statusCode).sort()).toEqual([202, 409])
  const settled = (await eventTypes(runId)).filter((t) => t === 'outcome.settled')
  expect(settled.length).toBe(1)
})

test('a cancel racing an outcome action never fails: it cancels the waiting run, or the run that the outcome resumed', async () => {
  const runId = await runWaitingForOutcome()
  const [outcome, cancel] = await Promise.all([
    authed('POST', `/v1/runs/${runId}/input`, { action: 'outcome_happened' }),
    authed('POST', `/v1/runs/${runId}/input`, { action: 'cancel' }),
  ])
  expect(cancel.statusCode).toBe(202)
  const log = await new PgRunStore(pool, 'default').readEvents(runId)
  if (outcome.statusCode === 202) {
    expect(log.filter((e) => e.type === 'outcome.settled')).toHaveLength(1)
    expect(cancel.json().status).toBe('running')
    expect([log.at(-1)!.type, log.at(-1)!.payload]).toEqual(['input.received', { action: 'cancel' }])
  } else {
    expect(outcome.statusCode).toBe(409)
    expect(log.at(-1)!.payload).toEqual({ from: 'waiting_human', to: 'cancelled' })
  }
})

test('input cancel cancels a queued run', async () => {
  await seedAgent()
  const { run_id } = (await authed('POST', '/v1/runs', runBody)).json()
  const res = await authed('POST', `/v1/runs/${run_id}/input`, { action: 'cancel' })
  expect(res.statusCode).toBe(202)
  expect(res.json()).toEqual({ run_id, status: 'cancelled' })
  expect((await authed('GET', `/v1/runs/${run_id}`)).json().status).toBe('cancelled')
  expect((await new PgRunStore(pool, 'default').readEvents(run_id)).at(-1)!.payload).toEqual({ from: 'queued', to: 'cancelled' })
})

test('input cancel cancels a waiting run', async () => {
  const runId = await runWaitingForApproval()
  const res = await authed('POST', `/v1/runs/${runId}/input`, { action: 'cancel' })
  expect(res.statusCode).toBe(202)
  expect(res.json()).toEqual({ run_id: runId, status: 'cancelled' })
  expect((await new PgRunStore(pool, 'default').readEvents(runId)).at(-1)!.payload).toEqual({ from: 'waiting_human', to: 'cancelled' })
})

test('input cancel on a finished run gives 409 run_not_cancellable; unknown run gives 404', async () => {
  const done = await runWaitingForApproval('r-done')
  expect((await authed('POST', `/v1/runs/${done}/input`, { action: 'cancel' })).statusCode).toBe(202)
  const again = await authed('POST', `/v1/runs/${done}/input`, { action: 'cancel' })
  expect(again.statusCode).toBe(409)
  expect(again.json().error.code).toBe('run_not_cancellable')

  expect((await authed('POST', '/v1/runs/ghost/input', { action: 'cancel' })).statusCode).toBe(404)
})

test('input cancel on a running run records a cancel input, keeps the state and makes its job due', async () => {
  const runId = await runWaitingForApproval()
  await migrator.query("UPDATE runs SET status = 'running', waiting_reason = NULL WHERE id = $1", [runId])
  await migrator.query("INSERT INTO queue (run_id, tenant_id, available_at) VALUES ($1, 'default', now() + interval '5 minutes') ON CONFLICT (run_id) DO UPDATE SET available_at = EXCLUDED.available_at", [runId])
  const res = await authed('POST', `/v1/runs/${runId}/input`, { action: 'cancel' })
  expect(res.statusCode).toBe(202)
  expect(res.json()).toEqual({ run_id: runId, status: 'running' })
  const last = (await new PgRunStore(pool, 'default').readEvents(runId)).at(-1)!
  expect([last.type, last.payload]).toEqual(['input.received', { action: 'cancel' }])
  const due = await migrator.query('SELECT available_at <= now() AS due FROM queue WHERE run_id = $1', [runId])
  expect(due.rows[0].due).toBe(true)
})

test('a message to a waiting run is recorded as untrusted input and leaves the state unchanged', async () => {
  const runId = await runWaitingForApproval()
  const res = await authed('POST', `/v1/runs/${runId}/input`, { action: 'message', text: 'Use express shipping' })
  expect(res.statusCode).toBe(202)
  expect(res.json()).toEqual({ run_id: runId, status: 'waiting_human' })
  const last = (await new PgRunStore(pool, 'default').readEvents(runId)).at(-1)!
  expect([last.type, last.payload, last.labels]).toEqual(['input.received', { action: 'message', text: 'Use express shipping' }, ['untrusted']])
  expect((await authed('GET', `/v1/runs/${runId}`)).json().status).toBe('waiting_human')
})

test('a message to a finished run gives 409 run_ended; an empty or overlong message gives 400', async () => {
  const runId = await runWaitingForApproval()
  expect((await authed('POST', `/v1/runs/${runId}/input`, { action: 'message', text: '' })).statusCode).toBe(400)
  expect((await authed('POST', `/v1/runs/${runId}/input`, { action: 'message', text: 'x'.repeat(32_001) })).statusCode).toBe(400)
  await authed('POST', `/v1/runs/${runId}/input`, { action: 'cancel' })
  const res = await authed('POST', `/v1/runs/${runId}/input`, { action: 'message', text: 'hi' })
  expect(res.statusCode).toBe(409)
  expect(res.json().error.code).toBe('run_ended')
})

test('the old resolve and cancel endpoints are gone', async () => {
  const runId = await runWaitingForApproval()
  expect((await authed('POST', `/v1/runs/${runId}/resolve`, { action: 'approve' })).statusCode).toBe(404)
  expect((await authed('POST', `/v1/runs/${runId}/cancel`)).statusCode).toBe(404)
})

test('two concurrent cancels: exactly one 202 and one 409', async () => {
  const runId = await runWaitingForOutcome()
  const results = await Promise.all([authed('POST', `/v1/runs/${runId}/input`, { action: 'cancel' }), authed('POST', `/v1/runs/${runId}/input`, { action: 'cancel' })])
  expect(results.map((r) => r.statusCode).sort()).toEqual([202, 409])
})

test('the settled handler queues run.waiting_human for non-approval waits only', async () => {
  const config = new ConfigRepo(pool, 'default', box)
  await config.putWebhook({ id: 'w1', url: 'https://a.test', secret: 's1', events: ['run.waiting_human'] })
  await config.putWebhook({ id: 'w2', url: 'https://b.test', secret: 's2', events: ['approval.requested'] })
  const settled = createRunSettledHandler(pool)

  await settled(await runWaitingForApproval(), 'default', 'waiting_human')
  expect((await migrator.query("SELECT 1 FROM webhook_deliveries WHERE type = 'run.waiting_human'")).rowCount).toBe(0)

  const runId = await runWaitingForOutcome()
  await settled(runId, 'default', 'waiting_human')
  const rows = await migrator.query<{ webhook_id: string; type: string; body: string }>(
    "SELECT webhook_id, type, body FROM webhook_deliveries WHERE type = 'run.waiting_human'",
  )
  expect(rows.rows.map((r) => r.webhook_id)).toEqual(['w1'])
  expect(JSON.parse(rows.rows[0]!.body).data).toMatchObject({
    run_id: runId,
    waiting_reason: 'unknown_outcome',
    pending_outcome: { tool_call_id: 'call_1', tool: 'payments.refund', args: { amount: 5 } },
  })
})

test('webhooks accept the run.waiting_human event', async () => {
  const res = await authed('POST', '/v1/webhooks', { url: 'https://a.test/hook', events: ['run.waiting_human'] })
  expect(res.statusCode).toBeLessThan(300)
})

test('a principal with an overlong id or too many roles gives 400', async () => {
  const run = (principal: unknown) => authed('POST', '/v1/runs', { agent: 'support', input: { text: 'hi' }, principal })
  for (const principal of [
    { id: 'x'.repeat(201), roles: [] },
    { id: 'cus_1', roles: Array.from({ length: 21 }, (_, i) => `r${i}`) },
    { id: 'cus_1', roles: ['r'.repeat(65)] },
  ]) {
    const res = await run(principal)
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('invalid_request')
  }
})

test('a cancel that lands while a worker starts the run wins, and the worker writes nothing', async () => {
  const { version } = await seedAgent()
  await createRun(pool, { tenantId: 'default', runId: 'r-race', agentId: 'helper', agentVersion: version, input: { text: 'hi' } })
  await new PgRunStore(pool, 'default').append('r-race', [{ type: 'run.created', payload: { agentId: 'helper', input: { text: 'hi' } }, labels: ['trusted'] }], {
    enqueue: true,
  })
  const waiters = async () => Number((await migrator.query<{ n: string }>('SELECT count(*) AS n FROM pg_locks WHERE NOT granted')).rows[0]!.n)
  const until = async (n: number) => {
    for (let i = 0; i < 200 && (await waiters()) < n; i++) await new Promise((r) => setTimeout(r, 10))
    expect(await waiters()).toBe(n)
  }
  let llmCalls = 0
  const llm: LLMPort = {
    complete: async () => {
      llmCalls++
      return { message: { role: 'assistant', content: 'done' }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end' }
    },
  }

  // Hold the run row, so the cancel and then the worker queue up on it in that order.
  const holder = await pool.connect()
  await holder.query('BEGIN')
  await holder.query('SET LOCAL ROLE agentcore_app')
  await holder.query("SELECT set_config('app.tenant_id', 'default', true)")
  await holder.query("SELECT 1 FROM runs WHERE id = 'r-race' FOR UPDATE")
  const cancel = authed('POST', '/v1/runs/r-race/input', { action: 'cancel' })
  await until(1)
  // The worker reads the run as queued, then waits to write queued -> running.
  const worker = startRunWorker({ secrets: box, pool, llm, tools: () => ({ call: async () => ({ content: '', isError: false }) }), workerId: 'w-race', pollMs: 10 })
  await until(2)
  await holder.query('COMMIT')
  holder.release()

  expect((await cancel).statusCode).toBe(202)
  for (let i = 0; i < 200 && (await migrator.query("SELECT 1 FROM queue WHERE run_id = 'r-race'")).rowCount !== 0; i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
  await worker.stop()
  const events = await new PgRunStore(pool, 'default').readEvents('r-race')
  expect(events.map((e) => [e.type, e.type === 'run.state_changed' ? e.payload.to : null])).toEqual([
    ['run.created', null],
    ['run.state_changed', 'cancelled'],
  ])
  expect(llmCalls).toBe(0)
  expect((await authed('GET', '/v1/runs/r-race')).json().status).toBe('cancelled')
})

test('an allow rule does not cover a tool whose definition changed: the worker waits for approval', async () => {
  await authed('POST', '/v1/connections', { id: 'shop', url: 'http://shop.test/mcp' })
  // An allow rule written for the definition the admin saw at registration.
  const { version } = await new ConfigRepo(pool, 'default', box).putAgent({
    ...agentBody,
    connections: ['shop'],
    allow: [{ tool: 'orders.get' }],
    autonomy: 'supervised',
    model: 'default',
  })
  await register(changedApp({ inputSchema: { type: 'object', properties: { order_id: { type: 'string' }, cancel: { type: 'boolean' } } } }))

  await createRun(pool, { tenantId: 'default', runId: 'r-changed', agentId: 'helper', agentVersion: version, input: { text: 'hi' } })
  await new PgRunStore(pool, 'default').append('r-changed', [{ type: 'run.created', payload: { agentId: 'helper', input: { text: 'hi' } }, labels: ['trusted'] }], {
    enqueue: true,
  })
  const llm: LLMPort = {
    complete: async () => ({
      message: { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'orders.get', arguments: { order_id: '1', cancel: true } }] },
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: 'tool_calls',
    }),
  }
  let toolCalls = 0
  const worker = startRunWorker({ secrets: box, pool, llm, tools: () => ({ call: async () => (toolCalls++, { content: '', isError: false }) }), workerId: 'w-ch', pollMs: 10 })
  for (let i = 0; i < 300 && (await authed('GET', '/v1/runs/r-changed')).json().status !== 'waiting_human'; i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
  await worker.stop()
  expect((await authed('GET', '/v1/runs/r-changed')).json()).toMatchObject({
    status: 'waiting_human',
    waiting_reason: 'approval',
    pending_approval: { tool: 'orders.get', reason: 'tool_changed_since_review' },
  })
  expect(toolCalls).toBe(0)
})

const tokensBreach: NewEvent = { type: 'limit.reached', payload: { limit: 'tokens', max: 10, value: 12 }, labels: [] }

test('continue on a limit wait grants the breached limit and queues the run', async () => {
  const runId = await runWaitingFor('limit', 'r-l', [tokensBreach])
  const res = await authed('POST', `/v1/runs/${runId}/input`, { action: 'continue' })
  expect(res.statusCode).toBe(202)
  expect(res.json()).toEqual({ run_id: runId, status: 'queued' })
  const events = await new PgRunStore(pool, 'default').readEvents(runId)
  expect(events.at(-2)).toMatchObject({ type: 'limit.continued', payload: { limit: 'tokens' }, labels: ['trusted'] })
  expect(events.at(-1)!.payload).toEqual({ from: 'waiting_human', to: 'running' })
  expect(await queueRows(runId)).toBe(1)
})

test('continue on a legacy breaker wait grants llm_calls', async () => {
  const runId = await runWaitingFor('breaker', 'r-b')
  expect((await authed('POST', `/v1/runs/${runId}/input`, { action: 'continue' })).statusCode).toBe(202)
  const events = await new PgRunStore(pool, 'default').readEvents(runId)
  expect(events.at(-2)).toMatchObject({ type: 'limit.continued', payload: { limit: 'llm_calls' } })
})

test('approve after the wait expired gives 409 not_waiting_human', async () => {
  const runId = await runWaitingForApproval('r-x')
  await new PgRunStore(pool, 'default').append(runId, [
    { type: 'limit.reached', payload: { limit: 'wait_human_s', max: 60, value: 61 }, labels: [] },
    { type: 'run.state_changed', payload: { from: 'waiting_human', to: 'failed', reason: 'wait_expired' }, labels: [] },
  ])
  const res = await authed('POST', `/v1/runs/${runId}/input`, { action: 'approve' })
  expect(res.statusCode).toBe(409)
  expect(res.json().error.code).toBe('not_waiting_for_approval')
})

test('only the admin key may set a limit above its default', async () => {
  const tenant = await createTenant(pool, 'acme')
  const asTenant = (body: unknown) =>
    app.inject({ method: 'POST', url: '/v1/agents', payload: body as object, headers: { authorization: `Bearer ${tenant!.apiKey}` } })
  const above = await asTenant({ ...agentBody, limits: { llm_calls: 31 } })
  expect(above.statusCode).toBe(403)
  expect(above.json().error).toMatchObject({ code: 'limit_above_default', message: expect.stringContaining('llm_calls') })
  expect((await asTenant({ ...agentBody, limits: { llm_calls: 10 } })).statusCode).toBe(201)
  expect((await authed('POST', '/v1/agents', { ...agentBody, limits: { llm_calls: 100 } })).statusCode).toBe(201)
  expect((await authed('POST', '/v1/agents', { ...agentBody, limits: { llm_calls: 0 } })).statusCode).toBe(400)
})

test('only the admin key may continue a run past the tenant daily cost', async () => {
  const tenant = await createTenant(pool, 'acme')
  const store = new PgRunStore(pool, 'acme')
  await new ConfigRepo(pool, 'acme', box).putAgent({ ...agentBody, autonomy: 'supervised', model: 'default' })
  await createRun(pool, { tenantId: 'acme', runId: 'r-day', agentId: 'helper', agentVersion: 1, input: { text: 'hi' } })
  await store.append('r-day', [
    { type: 'run.created', payload: { agentId: 'helper', input: { text: 'hi' } }, labels: ['trusted'] },
    { type: 'run.state_changed', payload: { from: 'queued', to: 'running' }, labels: [] },
    { type: 'limit.reached', payload: { limit: 'tenant_cost_usd_per_day', max: 20, value: 21 }, labels: [] },
    { type: 'run.state_changed', payload: { from: 'running', to: 'waiting_human', reason: 'limit' }, labels: [] },
  ])
  const before = (await store.readEvents('r-day')).length
  const asTenant = await app.inject({
    method: 'POST',
    url: '/v1/runs/r-day/input',
    payload: { action: 'continue' },
    headers: { authorization: `Bearer ${tenant!.apiKey}` },
  })
  expect(asTenant.statusCode).toBe(403)
  expect(asTenant.json().error.code).toBe('limit_needs_admin')
  expect((await store.readEvents('r-day')).length).toBe(before)
  const cancel = await app.inject({
    method: 'POST',
    url: '/v1/runs/r-day/input',
    payload: { action: 'cancel' },
    headers: { authorization: `Bearer ${tenant!.apiKey}` },
  })
  expect(cancel.statusCode).toBe(202)
})
