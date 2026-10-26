import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createSecretBox } from '@agent-core/core'
import type { LLMPort } from '@agent-core/core'
import { assertTestDatabase, createPool, runMigrations, runtimeTestUrl } from '@agent-core/store-postgres'
import { ensureAdminKeyHash, hashAdminKey } from '../../src/bootstrap'
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

const llm: LLMPort = {
  complete: async () => ({ message: { role: 'assistant', content: 'done' }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end' }),
}
const auth = { authorization: `Bearer ${ADMIN_KEY}` }

function start(opts: { llm: LLMPort | null; adminKeyHash?: Buffer; masterKeySource?: 'env' | 'file' }) {
  return createServiceStack({
    pool,
    adminKeyHash: opts.adminKeyHash ?? hashAdminKey(ADMIN_KEY),
    secrets: box,
    llm: opts.llm,
    masterKeySource: opts.masterKeySource,
    workerId: 'w1',
    runPollMs: 20,
    deliveryPollMs: 20,
  })
}

test('POST /v1/runs without agent runs the default agent at version 0', async () => {
  const stack = start({ llm })
  try {
    const res = await stack.app.inject({ method: 'POST', url: '/v1/runs?wait=10', headers: auth, payload: { input: { text: 'hi' } } })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('completed')
    const row = await migrator.query('SELECT agent_id, agent_version FROM runs')
    expect(row.rows).toEqual([{ agent_id: 'default', agent_version: 0 }])
  } finally {
    await stack.close()
  }
})

test('a workflow without agent is 422 and creates no run', async () => {
  const stack = start({ llm })
  try {
    const res = await stack.app.inject({ method: 'POST', url: '/v1/runs', headers: auth, payload: { workflow: 'w', input: { text: 'hi' } } })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('agent_required')
    expect((await migrator.query('SELECT 1 FROM runs')).rowCount).toBe(0)
  } finally {
    await stack.close()
  }
})

test('POST /v1/agents with id default is 422 reserved_agent_id', async () => {
  const stack = start({ llm })
  try {
    const res = await stack.app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: auth,
      payload: { id: 'default', instructions: 'x', connections: [], autonomy: 'supervised', allow: [] },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toMatchObject({ code: 'reserved_agent_id', fix: expect.any(String) })
    expect((await migrator.query('SELECT 1 FROM agents')).rowCount).toBe(0)
  } finally {
    await stack.close()
  }
})

test('without an LLM: POST /v1/runs is 503 llm_not_configured with no run row, and /readyz names it', async () => {
  const stack = start({ llm: null })
  try {
    const run = await stack.app.inject({ method: 'POST', url: '/v1/runs', headers: auth, payload: { input: { text: 'hi' } } })
    expect(run.statusCode).toBe(503)
    expect(run.json().error).toMatchObject({ code: 'llm_not_configured', fix: expect.any(String) })
    expect((await migrator.query('SELECT 1 FROM runs')).rowCount).toBe(0)
    const ready = await stack.app.inject({ method: 'GET', url: '/readyz' })
    expect(ready.statusCode).toBe(503)
    expect(ready.json().checks).toContainEqual(expect.objectContaining({ name: 'llm', ok: false, code: 'llm_not_configured' }))
  } finally {
    await stack.close()
  }
})

test('a master key from a file shows in /readyz', async () => {
  const stack = start({ llm, masterKeySource: 'file' })
  try {
    const ready = await stack.app.inject({ method: 'GET', url: '/readyz' })
    expect(ready.json().checks).toContainEqual(expect.objectContaining({ name: 'master_key', ok: true, code: 'master_key_generated' }))
  } finally {
    await stack.close()
  }
})

test('the generated admin key authenticates, and a wrong key does not', async () => {
  const lines: string[] = []
  const { hash } = await ensureAdminKeyHash(migrator, null, (l) => lines.push(l))
  const generated = /ak_admin\.\S+/.exec(lines[0]!)![0]
  const stack = start({ llm, adminKeyHash: hash })
  try {
    const ok = await stack.app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${generated}` } })
    expect(ok.statusCode).toBe(200)
    const bad = await stack.app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer ak_admin.wrong' } })
    expect(bad.statusCode).toBe(401)
  } finally {
    await stack.close()
  }
})
