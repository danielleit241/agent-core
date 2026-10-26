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
  const stack = createServiceStack({ pool, adminKeyHash: hashAdminKey(ADMIN_KEY), secrets: box, llm, workerId: 'w1', runPollMs: 20, deliveryPollMs: 20 })
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
