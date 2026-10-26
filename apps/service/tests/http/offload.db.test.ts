import { hashAdminKey } from '../../src/bootstrap'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createSecretBox } from '@agent-core/core'
import type { LLMPort, Message, StoredEvent } from '@agent-core/core'
import { ConfigRepo, assertTestDatabase, createPool, createTenant, runMigrations, runtimeTestUrl } from '@agent-core/store-postgres'
import { createServiceStack } from '../../src/stack'

const box = createSecretBox(Buffer.alloc(32, 7))
const url = process.env.TEST_DATABASE_URL ?? 'postgres://agentcore:agentcore@localhost:5433/agentcore_test'
const ADMIN_KEY = 'test-admin-key'
let migrator: ReturnType<typeof createPool>
let pool: ReturnType<typeof createPool>

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
  await pool.end()
  await migrator.end()
})

const LONG = `${'line of text\n'.repeat(1_500)}NEEDLE-4711\n${'line of text\n'.repeat(1_500)}` // 39,000 characters

async function offloadStack() {
  const requests: { messages: Message[]; tools: { name: string }[] }[] = []
  const llm: LLMPort = {
    complete: async (req) => {
      requests.push(req)
      return { message: { role: 'assistant', content: 'done' }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end' }
    },
  }
  const stack = createServiceStack({ pool, adminKeyHash: hashAdminKey(ADMIN_KEY), secrets: box, llm, llmApiKey: undefined, workerId: 'w1', runPollMs: 20, deliveryPollMs: 20 })
  await new ConfigRepo(pool, 'default', box).putAgent({ id: 'helper', instructions: 'help', connections: [], autonomy: 'supervised', allow: [], model: 'default' })
  const call = (method: 'GET' | 'POST', path: string, payload?: unknown, headers: Record<string, string> = {}) =>
    stack.app.inject({ method, url: path, headers: { authorization: `Bearer ${ADMIN_KEY}`, ...headers }, payload: payload as object | undefined })
  return { stack, requests, call }
}

test('a long run input is offloaded: the LLM sees the preview and the operator reads the full text', async () => {
  const { stack, requests, call } = await offloadStack()
  try {
    const run = await call('POST', '/v1/runs?wait=10', { agent: 'helper', input: { text: LONG } })
    const runId = run.json<{ id: string }>().id
    const events = (await call('GET', `/v1/runs/${runId}/events`)).json<{ events: StoredEvent[] }>().events
    const created = events[0]!
    if (created.type !== 'run.created') throw new Error('first event is not run.created')
    const offload = created.payload.input.offload!
    expect(offload).toMatchObject({ chars: LONG.length, lines: 3_002 })
    expect(created.payload.input.text.length).toBeLessThan(2_100)
    const user = requests[0]!.messages.find((m) => m.role === 'user')!
    expect(user.content).toBe(created.payload.input.text)
    expect(user.content).toContain(offload.handle)
    expect(requests[0]!.tools.map((t) => t.name)).toContain('agent_core.read_output')

    const full = await call('GET', `/v1/runs/${runId}/outputs/${offload.handle}`)
    expect(full.statusCode).toBe(200)
    expect(full.headers['content-type']).toContain('text/plain')
    expect(full.body).toBe(LONG)
    expect((await call('GET', `/v1/runs/${runId}/outputs/out_000000000000`)).statusCode).toBe(404)
  } finally {
    await stack.close()
  }
})

test('an input at the threshold stays whole, and a run without a long input does not offer read_output', async () => {
  const { stack, requests, call } = await offloadStack()
  try {
    await call('POST', '/v1/runs?wait=10', { agent: 'helper', input: { text: 'x'.repeat(8_000) } })
    expect(requests[0]!.messages.find((m) => m.role === 'user')!.content).toHaveLength(8_000)
    expect(requests[0]!.tools.map((t) => t.name)).not.toContain('agent_core.read_output')
  } finally {
    await stack.close()
  }
})

test('another tenant gets 404 for the output of a run', async () => {
  const { stack, call } = await offloadStack()
  try {
    await createTenant(pool, 'acme')
    const run = await call('POST', '/v1/runs?wait=10', { agent: 'helper', input: { text: LONG } })
    const runId = run.json<{ id: string }>().id
    const events = (await call('GET', `/v1/runs/${runId}/events`)).json<{ events: StoredEvent[] }>().events
    const created = events[0]!
    if (created.type !== 'run.created') throw new Error('first event is not run.created')
    const handle = created.payload.input.offload!.handle
    const issued = await call('POST', '/v1/tenants/acme/keys', {})
    expect(issued.statusCode).toBe(201)
    const other = await stack.app.inject({
      method: 'GET',
      url: `/v1/runs/${runId}/outputs/${handle}`,
      headers: { authorization: `Bearer ${issued.json<{ api_key: string }>().api_key}` },
    })
    expect(other.statusCode).toBe(404)
  } finally {
    await stack.close()
  }
})

test('a workflow run input is screened but not offloaded', async () => {
  const { stack, call } = await offloadStack()
  try {
    await new ConfigRepo(pool, 'default', box).putAgent({
      id: 'flow',
      instructions: 'flow',
      connections: [],
      autonomy: 'supervised',
      allow: [],
      model: 'default',
      workflows: { echo: { start: 'ask', steps: { ask: { kind: 'approval', reason: 'ok?' } } } },
    })
    const run = await call('POST', '/v1/runs', { agent: 'flow', workflow: 'echo', input: { text: LONG } })
    const runId = run.json<{ run_id: string }>().run_id
    const events = (await call('GET', `/v1/runs/${runId}/events`)).json<{ events: StoredEvent[] }>().events
    const created = events[0]!
    if (created.type !== 'run.created') throw new Error('first event is not run.created')
    expect(created.payload.input.offload).toBeUndefined()
    expect(created.payload.input.text).toBe(LONG)
  } finally {
    await stack.close()
  }
})

test('a run input with a NUL byte and a lone surrogate is offloaded: the blob is stored and the run completes', async () => {
  const { stack, call } = await offloadStack()
  try {
    const dirty = `a${String.fromCharCode(0)}${'x'.repeat(9_000)}${String.fromCharCode(0xd83d)}b`
    const run = await call('POST', '/v1/runs?wait=10', { agent: 'helper', input: { text: dirty } })
    expect(run.statusCode).toBe(200)
    expect(run.json<{ status: string }>().status).toBe('completed')
    const runId = run.json<{ id: string }>().id
    const created = (await call('GET', `/v1/runs/${runId}/events`)).json<{ events: StoredEvent[] }>().events[0]!
    if (created.type !== 'run.created') throw new Error('first event is not run.created')
    const full = await call('GET', `/v1/runs/${runId}/outputs/${created.payload.input.offload!.handle}`)
    expect(full.body).toBe(`a\ufffd${'x'.repeat(9_000)}\ufffdb`)
  } finally {
    await stack.close()
  }
})
