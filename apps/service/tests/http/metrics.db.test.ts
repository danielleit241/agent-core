import { hashAdminKey } from '../../src/bootstrap'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createSecretBox } from '@agent-core/core'
import type { LLMPort } from '@agent-core/core'
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

const LINE = /^agent_core_[a-z_]+(\{[^}]*\})? \d+(\.\d+)?$/

function value(text: string, series: string): number {
  const line = text.split('\n').find((l) => l.startsWith(series + ' '))
  if (!line) throw new Error(`no series ${series}`)
  return Number(line.slice(series.length + 1))
}

test('/metrics is Prometheus text, counts runs and LLM calls, and has no tenant data', async () => {
  const llm: LLMPort = {
    complete: async () => ({ message: { role: 'assistant', content: 'done' }, usage: { inputTokens: 5, outputTokens: 3 }, stopReason: 'end' }),
  }
  const stack = createServiceStack({ pool, adminKeyHash: hashAdminKey(ADMIN_KEY), secrets: box, llm, llmApiKey: undefined, workerId: 'w1', runPollMs: 20, deliveryPollMs: 20 })
  try {
    await createTenant(pool, 'acme-secret-tenant')
    await new ConfigRepo(pool, 'default', box).putAgent({ id: 'helper', instructions: 'help', connections: [], autonomy: 'supervised', allow: [], model: 'default' })
    const before = (await stack.app.inject({ method: 'GET', url: '/metrics' })).body
    const res = await stack.app.inject({
      method: 'POST',
      url: '/v1/runs?wait=10',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { agent: 'helper', input: { text: 'hi' } },
    })
    expect(res.json<{ status: string }>().status).toBe('completed')

    const metrics = await stack.app.inject({ method: 'GET', url: '/metrics' })
    expect(metrics.headers['content-type']).toContain('text/plain; version=0.0.4')
    const lines = metrics.body.split('\n').filter((l) => l !== '' && !l.startsWith('#'))
    for (const l of lines) expect(l).toMatch(LINE)
    expect(metrics.body).toContain('agent_core_runs{status="completed"} 1')
    expect(value(metrics.body, 'agent_core_llm_calls_total{outcome="ok"}')).toBe(value(before, 'agent_core_llm_calls_total{outcome="ok"}') + 1)
    expect(value(metrics.body, 'agent_core_llm_tokens_total{kind="input"}')).toBe(value(before, 'agent_core_llm_tokens_total{kind="input"}') + 5)
    expect(value(metrics.body, 'agent_core_http_requests_total{method="POST",status_class="2xx"}')).toBeGreaterThanOrEqual(1)
    expect(metrics.body).not.toMatch(/acme-secret-tenant|run_|helper/)
  } finally {
    await stack.close()
  }
})

test('/metrics counts the secrets removed from a run input by kind, never a value', async () => {
  const llm: LLMPort = {
    complete: async () => ({ message: { role: 'assistant', content: 'done' }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end' }),
  }
  const stack = createServiceStack({ pool, adminKeyHash: hashAdminKey(ADMIN_KEY), secrets: box, llm, llmApiKey: undefined, workerId: 'w1', runPollMs: 20, deliveryPollMs: 20 })
  try {
    await new ConfigRepo(pool, 'default', box).putAgent({ id: 'helper', instructions: 'help', connections: [], autonomy: 'supervised', allow: [], model: 'default' })
    const series = 'agent_core_redactions_total{kind="aws_access_key"}'
    const before = (await stack.app.inject({ method: 'GET', url: '/metrics' })).body
    const base = before.includes(series) ? value(before, series) : 0
    await stack.app.inject({
      method: 'POST',
      url: '/v1/runs?wait=10',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { agent: 'helper', input: { text: 'key AKIAIOSFODNN7EXAMPLE' } },
    })
    const metrics = (await stack.app.inject({ method: 'GET', url: '/metrics' })).body
    expect(value(metrics, series)).toBe(base + 1)
    expect(metrics).not.toContain('AKIAIOSFODNN7EXAMPLE')
  } finally {
    await stack.close()
  }
})

const AWS_SERIES = 'agent_core_redactions_total{kind="aws_access_key"}'

async function redactionStack() {
  const llm: LLMPort = {
    complete: async () => ({ message: { role: 'assistant', content: 'done' }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end' }),
  }
  const stack = createServiceStack({ pool, adminKeyHash: hashAdminKey(ADMIN_KEY), secrets: box, llm, llmApiKey: undefined, workerId: 'w1', runPollMs: 20, deliveryPollMs: 20 })
  await new ConfigRepo(pool, 'default', box).putAgent({ id: 'helper', instructions: 'help', connections: [], autonomy: 'supervised', allow: [], model: 'default' })
  const count = async (): Promise<number> => {
    const body = (await stack.app.inject({ method: 'GET', url: '/metrics' })).body
    return body.includes(AWS_SERIES) ? value(body, AWS_SERIES) : 0
  }
  const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
    stack.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${ADMIN_KEY}`, ...headers }, payload: payload as object })
  return { stack, count, post }
}

test('an idempotent replay of POST /v1/runs does not count its redactions twice', async () => {
  const { stack, count, post } = await redactionStack()
  try {
    const before = await count()
    const body = { agent: 'helper', input: { text: 'key AKIAIOSFODNN7EXAMPLE' } }
    expect((await post('/v1/runs?wait=10', body, { 'idempotency-key': 'k1' })).statusCode).toBe(200)
    const replay = await post('/v1/runs?wait=10', body, { 'idempotency-key': 'k1' })
    expect(replay.headers['idempotent-replayed']).toBe('true')
    expect(await count()).toBe(before + 1)
  } finally {
    await stack.close()
  }
})

test('a message to an ended run is refused and its redactions are not counted', async () => {
  const { stack, count, post } = await redactionStack()
  try {
    const run = await post('/v1/runs?wait=10', { agent: 'helper', input: { text: 'hi' } })
    const before = await count()
    const res = await post(`/v1/runs/${run.json<{ id: string }>().id}/input`, { action: 'message', text: 'key AKIAIOSFODNN7EXAMPLE' })
    expect(res.statusCode).toBe(409)
    expect(await count()).toBe(before)
  } finally {
    await stack.close()
  }
})

test('a message of 31,995 characters that gets longer after redaction is accepted', async () => {
  const llm: LLMPort = {
    complete: async () => ({
      message: { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'agent_core.ask_human', arguments: { question: 'q' } }] },
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: 'tool_calls',
    }),
  }
  const stack = createServiceStack({ pool, adminKeyHash: hashAdminKey(ADMIN_KEY), secrets: box, llm, llmApiKey: undefined, workerId: 'w1', runPollMs: 20, deliveryPollMs: 20 })
  try {
    await new ConfigRepo(pool, 'default', box).putAgent({ id: 'helper', instructions: 'help', connections: [], autonomy: 'supervised', allow: [], model: 'default' })
    const headers = { authorization: `Bearer ${ADMIN_KEY}` }
    const run = await stack.app.inject({ method: 'POST', url: '/v1/runs?wait=10', headers, payload: { agent: 'helper', input: { text: 'hi' } } })
    const text = 'password=hunter2hunter2 '.padEnd(31_995, 'a')
    expect(text).toHaveLength(31_995)
    const res = await stack.app.inject({ method: 'POST', url: `/v1/runs/${run.json<{ id: string }>().id}/input`, headers, payload: { action: 'message', text } })
    expect(res.statusCode).toBe(202)
  } finally {
    await stack.close()
  }
})
