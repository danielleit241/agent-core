import { hashAdminKey } from '../../../src/bootstrap'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { canonicalJson, createSecretBox, snapshotRequest } from '@agent-core/core'
import type { Message, NewEvent, ToolDescriptor } from '@agent-core/core'
import { ConfigRepo, PgContentStore, PgRunStore, assertTestDatabase, createPool, createRun, createTenant, runMigrations, runtimeTestUrl } from '@agent-core/store-postgres'
import { buildApp } from '../../../src/http/app'

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
  app = buildApp({ secrets: box, pool, adminKeyHash: hashAdminKey(ADMIN_KEY) })
})
afterAll(async () => {
  await pool.end()
  await migrator.end()
})

const get = (path: string, key = ADMIN_KEY) => app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${key}` } })

const TOOL: ToolDescriptor = {
  name: 'orders.get',
  description: 'get an order',
  inputSchema: { type: 'object' },
  safety: { effect: 'read', idempotency: false, reachesOutside: false, outputLabel: 'internal' },
  connectionId: 'shop',
}
const SYSTEM: Message = { role: 'system', content: 'be brief' }
const USER: Message = { role: 'user', content: 'hi' }
const ASSISTANT: Message = { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'orders.get', arguments: { id: 1 } }] }
const TOOL_MSG: Message = { role: 'tool', content: 'shipped', toolCallId: 'c1' }
const time = (at: string): Message => ({ role: 'system', content: `Current time: ${at}`, volatile: true })
const OUTPUT = { name: 'step_s', schema: { type: 'object' } }

const responded = (message: Message, stopReason: 'end' | 'tool_calls'): NewEvent => ({
  type: 'llm.responded',
  payload: { message, usage: { inputTokens: 3, outputTokens: 2 }, stopReason },
  labels: [],
})

/** A run with two snapshotted LLM calls, an old call without a snapshot first. Seqs: 3 (old), 5, 7. */
async function seedRun(tenantId: string, runId = 'r1'): Promise<void> {
  await new ConfigRepo(pool, tenantId, box).putAgent({ id: 'helper', instructions: 'help', connections: [], autonomy: 'supervised', allow: [], model: 'default' })
  await createRun(pool, { tenantId, runId, agentId: 'helper', agentVersion: 1, input: { text: 'hi' } })
  const content = new PgContentStore(pool, tenantId)
  const first = await snapshotRequest(content, { messages: [SYSTEM, time('1'), USER], tools: [TOOL] })
  const second = await snapshotRequest(content, { messages: [SYSTEM, time('2'), USER, ASSISTANT, TOOL_MSG], tools: [TOOL], output: OUTPUT })
  await new PgRunStore(pool, tenantId).append(runId, [
    { type: 'run.created', payload: { agentId: 'helper', input: { text: 'hi' } }, labels: ['trusted'] },
    { type: 'run.state_changed', payload: { from: 'queued', to: 'running' }, labels: [] },
    { type: 'llm.requested', payload: { model: 'm0' }, labels: [] },
    responded({ role: 'assistant', content: 'old' }, 'end'),
    { type: 'llm.requested', payload: { model: 'm1', context: first }, labels: [] },
    responded(ASSISTANT, 'tool_calls'),
    { type: 'llm.requested', payload: { model: 'm1', context: second }, labels: [] },
    responded({ role: 'assistant', content: 'done' }, 'end'),
  ])
}

test('GET llm-calls lists each call with parts, newParts and chars per role', async () => {
  await seedRun('default')
  const res = await get('/v1/runs/r1/llm-calls')
  expect(res.statusCode).toBe(200)
  const toolCallsChars = canonicalJson(ASSISTANT.toolCalls).length
  const toolChars = JSON.stringify({ description: 'get an order', inputSchema: { type: 'object' }, name: 'orders.get' }).length
  expect(res.json()).toEqual({
    calls: [
      { seq: 3, model: 'm0', usage: { inputTokens: 3, outputTokens: 2 }, stopReason: 'end', parts: 0, newParts: 0 },
      {
        seq: 5,
        model: 'm1',
        usage: { inputTokens: 3, outputTokens: 2 },
        stopReason: 'tool_calls',
        parts: 4,
        newParts: 3,
        chars: { system: 8 + 'Current time: 1'.length, user: 2, assistant: 0, tool: 0, tools: toolChars },
      },
      {
        seq: 7,
        model: 'm1',
        usage: { inputTokens: 3, outputTokens: 2 },
        stopReason: 'end',
        parts: 6,
        // Only the assistant and the tool message are new: the system, user and tool descriptor were sent before,
        // and the time item is inline.
        newParts: 2,
        // The assistant turn counts its tool calls (changed on purpose: it was 0 when only `content` counted).
        chars: { system: 8 + 'Current time: 2'.length, user: 2, assistant: toolCallsChars, tool: 7, tools: toolChars },
      },
    ],
  })
})

test('GET llm-calls/{seq} rebuilds the messages and tools from the blobs', async () => {
  await seedRun('default')
  const res = await get('/v1/runs/r1/llm-calls/7')
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({
    seq: 7,
    model: 'm1',
    messages: [SYSTEM, { role: 'system', content: 'Current time: 2' }, USER, ASSISTANT, TOOL_MSG],
    tools: [{ name: 'orders.get', description: 'get an order', inputSchema: { type: 'object' } }],
    output: OUTPUT,
  })
  // A call without an output schema leaves the field out.
  expect((await get('/v1/runs/r1/llm-calls/5')).json()).not.toHaveProperty('output')
})

test('a retried call and two requests in a row pair with the right response', async () => {
  await new ConfigRepo(pool, 'default', box).putAgent({ id: 'helper', instructions: 'help', connections: [], autonomy: 'supervised', allow: [], model: 'default' })
  await createRun(pool, { tenantId: 'default', runId: 'r2', agentId: 'helper', agentVersion: 1, input: { text: 'hi' } })
  const ctx = await snapshotRequest(new PgContentStore(pool, 'default'), { messages: [USER], tools: [] })
  const requested = (model: string): NewEvent => ({ type: 'llm.requested', payload: { model, context: ctx }, labels: [] })
  await new PgRunStore(pool, 'default').append('r2', [
    { type: 'run.created', payload: { agentId: 'helper', input: { text: 'hi' } }, labels: ['trusted'] },
    requested('retry-1'), // 2: fails, then is retried
    { type: 'error.raised', payload: { message: 'overloaded', retryable: true, retryAt: '2030-01-01T00:00:00.000Z' }, labels: [] },
    requested('retry-2'), // 4: answered
    responded({ role: 'assistant', content: 'a' }, 'end'),
    requested('crash-1'), // 6: the worker died mid-call
    requested('crash-2'), // 7: answered after the resume
    responded({ role: 'assistant', content: 'b' }, 'end'),
  ])
  const calls = (await get('/v1/runs/r2/llm-calls')).json().calls as { seq: number; model: string; stopReason: string | null }[]
  expect(calls.map((c) => [c.seq, c.model, c.stopReason])).toEqual([
    [2, 'retry-1', null],
    [4, 'retry-2', 'end'],
    [6, 'crash-1', null],
    [7, 'crash-2', 'end'],
  ])
})

test('llm-calls/{seq} is 404 for a call without a snapshot, a seq that is not llm.requested, a bad seq and an unknown run', async () => {
  await seedRun('default')
  for (const path of ['/v1/runs/r1/llm-calls/3', '/v1/runs/r1/llm-calls/6', '/v1/runs/r1/llm-calls/99', '/v1/runs/r1/llm-calls/x']) {
    const res = await get(path)
    expect([path, res.statusCode, res.json().error.code]).toEqual([path, 404, 'llm_call_not_found'])
  }
  for (const path of ['/v1/runs/ghost/llm-calls', '/v1/runs/ghost/llm-calls/5']) {
    const res = await get(path)
    expect([path, res.statusCode, res.json().error.code]).toEqual([path, 404, 'run_not_found'])
  }
})

test("another tenant's run is 404 on both routes, and its owner still reads it", async () => {
  const acme = await createTenant(pool, 'acme')
  const other = await createTenant(pool, 'other')
  await seedRun('acme')
  expect((await get('/v1/runs/r1/llm-calls', acme!.apiKey)).statusCode).toBe(200)
  expect((await get('/v1/runs/r1/llm-calls/5', acme!.apiKey)).statusCode).toBe(200)
  for (const path of ['/v1/runs/r1/llm-calls', '/v1/runs/r1/llm-calls/5']) {
    const res = await get(path, other!.apiKey)
    expect([path, res.statusCode, res.json().error.code]).toEqual([path, 404, 'run_not_found'])
  }
})
