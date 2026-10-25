import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import type { AgentDefinition, LLMPort, RunStatus, ToolInvoker } from '@agent-core/core'
import { ConfigRepo, PgRunStore, assertTestDatabase, createPool, createRun, createTenant, enqueue, getRun, runMigrations } from '@agent-core/store-postgres'
import { startRunWorker } from '../../src/worker/worker'
import type { RunWorkerDeps } from '../../src/worker/worker'
import { createSecretBox } from '@agent-core/core'

const box = createSecretBox(Buffer.alloc(32, 7))
const url = process.env.TEST_DATABASE_URL ?? 'postgres://agentcore:agentcore@localhost:5433/agentcore_test'
let pool: ReturnType<typeof createPool>

beforeAll(() => {
  assertTestDatabase(url)
  pool = createPool(url)
})
beforeEach(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(pool)
})
afterAll(async () => {
  await pool.end()
})

const llm: LLMPort = {
  complete: async () => ({
    message: { role: 'assistant', content: 'done' },
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: 'end',
  }),
}
const noTools: ToolInvoker = {
  call: async () => {
    throw new Error('no tools expected')
  },
}
const tools = (): ToolInvoker => noTools
const agent: AgentDefinition = {
  id: 'helper',
  instructions: 'help',
  connections: [],
  autonomy: 'supervised',
  allow: [],
  model: 'default',
}

async function seedRun(runId: string, agentId: string, agentVersion: number): Promise<void> {
  await createRun(pool, { tenantId: 'default', runId, agentId, agentVersion, input: { text: 'hi' } })
  await new PgRunStore(pool, 'default').append(runId, [
    { type: 'run.created', payload: { agentId, input: { text: 'hi' } }, labels: ['trusted'] },
  ])
  await enqueue(pool, { runId, tenantId: 'default' })
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 50))
  expect(cond()).toBe(true)
}

const queueRows = async (): Promise<number> => (await pool.query('SELECT 1 FROM queue')).rowCount ?? 0

test('a queued run is claimed, completed and released', async () => {
  const { version } = await new ConfigRepo(pool, 'default', box).putAgent(agent)
  await seedRun('r1', 'helper', version)
  const settled: Array<[string, RunStatus]> = []
  const worker = startRunWorker({
    secrets: box,
    pool,
    llm,
    tools,
    workerId: 'w1',
    pollMs: 20,
    onRunSettled: async (id, _tenantId, status) => {
      settled.push([id, status])
    },
  })
  await waitFor(() => settled.length === 1)
  await worker.stop()
  expect(settled).toEqual([['r1', 'completed']])
  expect((await getRun(pool, 'default', 'r1'))?.status).toBe('completed')
  expect(await queueRows()).toBe(0)
})

test('a run whose agent is missing fails with error.raised and is released', async () => {
  await seedRun('r2', 'ghost', 1)
  const settled: Array<[string, RunStatus]> = []
  const worker = startRunWorker({
    secrets: box,
    pool,
    llm,
    tools,
    workerId: 'w1',
    pollMs: 20,
    onRunSettled: async (id, _tenantId, status) => {
      settled.push([id, status])
    },
  })
  await waitFor(() => settled.length === 1)
  await worker.stop()
  expect(settled).toEqual([['r2', 'failed']])
  const events = await new PgRunStore(pool, 'default').readEvents('r2')
  expect(events.some((e) => e.type === 'error.raised')).toBe(true)
  expect((await getRun(pool, 'default', 'r2'))?.status).toBe('failed')
  expect(await queueRows()).toBe(0)
})

test('stop resolves while idle', async () => {
  const worker = startRunWorker({ secrets: box, pool, llm, tools, workerId: 'w1', pollMs: 20 })
  await new Promise((r) => setTimeout(r, 60))
  await worker.stop()
})

const runStatus = async (id: string): Promise<RunStatus | undefined> => (await getRun(pool, 'default', id))?.status

test('a failure on a completed run appends nothing and reports the real status', async () => {
  await seedRun('r3', 'ghost', 1)
  const store = new PgRunStore(pool, 'default')
  await store.append('r3', [{ type: 'run.state_changed', payload: { from: 'queued', to: 'completed' }, labels: [] }])
  const before = (await store.readEvents('r3')).length
  const settled: Array<[string, RunStatus]> = []
  const worker = startRunWorker({
    secrets: box,
    pool,
    llm,
    tools,
    workerId: 'w1',
    pollMs: 20,
    onRunSettled: async (id, _tenantId, status) => {
      settled.push([id, status])
    },
  })
  await waitFor(() => settled.length === 1)
  await worker.stop()
  expect(settled).toEqual([['r3', 'completed']])
  expect((await store.readEvents('r3')).length).toBe(before)
  expect(await runStatus('r3')).toBe('completed')
})

test('when the failure cannot be recorded the job stays locked and onRunSettled is not called', async () => {
  // queue row without a runs row: loading fails and the append fails too
  await enqueue(pool, { runId: 'orphan', tenantId: 'default' })
  const settled: string[] = []
  const worker = startRunWorker({
    secrets: box,
    pool,
    llm,
    tools,
    workerId: 'w1',
    pollMs: 20,
    onRunSettled: async (id) => {
      settled.push(id)
    },
  })
  await new Promise((r) => setTimeout(r, 400))
  await worker.stop()
  expect(settled).toEqual([])
  const rows = await pool.query('SELECT locked_by FROM queue WHERE run_id = $1', ['orphan'])
  expect(rows.rows).toEqual([{ locked_by: 'w1' }])
})

test('two connections exposing the same tool name fail the run', async () => {
  const config = new ConfigRepo(pool, 'default', box)
  const tool = (connectionId: string) => ({
    name: 'dup',
    description: 'd',
    inputSchema: {},
    safety: { effect: 'read' as const, idempotency: true, reachesOutside: false, outputLabel: 'trusted' as const },
    connectionId,
    source: {},
    confirmed: {},
  })
  await config.putConnection({ id: 'c1', kind: 'mcp', url: 'http://x', tools: [tool('c1')] })
  await config.putConnection({ id: 'c2', kind: 'mcp', url: 'http://y', tools: [tool('c2')] })
  const { version } = await config.putAgent({ ...agent, connections: ['c1', 'c2'] })
  await seedRun('r4', 'helper', version)
  const settled: Array<[string, RunStatus]> = []
  const worker = startRunWorker({
    secrets: box,
    pool,
    llm,
    tools,
    workerId: 'w1',
    pollMs: 20,
    onRunSettled: async (id, _tenantId, status) => {
      settled.push([id, status])
    },
  })
  await waitFor(() => settled.length === 1)
  await worker.stop()
  expect(settled).toEqual([['r4', 'failed']])
  const events = await new PgRunStore(pool, 'default').readEvents('r4')
  const err = events.find((e) => e.type === 'error.raised')
  expect(err?.payload).toMatchObject({ message: 'duplicate tool name: dup' })
})

test('a transient load error re-enqueues the run 5 s ahead without failing it', async () => {
  const { version } = await new ConfigRepo(pool, 'default', box).putAgent(agent)
  await seedRun('r5', 'helper', version)
  const settled: string[] = []
  const loadContext: RunWorkerDeps['loadContext'] = async () => {
    throw new Error('connection reset')
  }
  const worker = startRunWorker({
    secrets: box,
    pool,
    llm,
    tools,
    workerId: 'w1',
    pollMs: 20,
    loadContext,
    onRunSettled: async (id) => {
      settled.push(id)
    },
  })
  await new Promise((r) => setTimeout(r, 400))
  await worker.stop()
  expect(settled).toEqual([])
  expect(await runStatus('r5')).toBe('queued')
  const rows = await pool.query(
    "SELECT locked_by, available_at > now() + interval '3 seconds' AS later FROM queue WHERE run_id = 'r5'",
  )
  expect(rows.rows).toEqual([{ locked_by: null, later: true }])
})

test('the worker heartbeats the lock while a job is processing', async () => {
  const { version } = await new ConfigRepo(pool, 'default', box).putAgent(agent)
  await seedRun('r6', 'helper', version)
  await pool.query("UPDATE queue SET available_at = now()")
  let lockedAtDuring: Date | undefined
  const slowLlm: LLMPort = {
    complete: async (req) => {
      await pool.query("UPDATE queue SET locked_at = now() - interval '1 hour' WHERE run_id = 'r6'")
      await new Promise((r) => setTimeout(r, 150))
      const res = await pool.query<{ locked_at: Date }>("SELECT locked_at FROM queue WHERE run_id = 'r6'")
      lockedAtDuring = res.rows[0]?.locked_at
      return llm.complete(req)
    },
  }
  const settled: string[] = []
  const worker = startRunWorker({
    secrets: box,
    pool,
    llm: slowLlm,
    tools,
    workerId: 'w1',
    pollMs: 20,
    heartbeatMs: 30,
    onRunSettled: async (id) => {
      settled.push(id)
    },
  })
  await waitFor(() => settled.length === 1)
  await worker.stop()
  expect(lockedAtDuring && Date.now() - lockedAtDuring.getTime() < 60_000).toBe(true)
})

test('a tool named like an Object.prototype member is not reported as a duplicate', async () => {
  const config = new ConfigRepo(pool, 'default', box)
  const tool = {
    name: 'toString',
    description: 'd',
    inputSchema: {},
    safety: { effect: 'read' as const, idempotency: true, reachesOutside: false, outputLabel: 'trusted' as const },
    connectionId: 'c1',
    source: {},
    confirmed: {},
  }
  await config.putConnection({ id: 'c1', kind: 'mcp', url: 'http://x', tools: [tool] })
  const { version } = await config.putAgent({ ...agent, connections: ['c1'] })
  await seedRun('r7', 'helper', version)
  const settled: Array<[string, RunStatus]> = []
  const worker = startRunWorker({
    secrets: box,
    pool,
    llm,
    tools,
    workerId: 'w1',
    pollMs: 20,
    onRunSettled: async (id, _tenantId, status) => {
      settled.push([id, status])
    },
  })
  await waitFor(() => settled.length === 1)
  await worker.stop()
  expect(settled).toEqual([['r7', 'completed']])
})

test('when onRunSettled fails the queue row stays so the job is retried', async () => {
  const { version } = await new ConfigRepo(pool, 'default', box).putAgent(agent)
  await seedRun('r8', 'helper', version)
  let attempts = 0
  const worker = startRunWorker({
    secrets: box,
    pool,
    llm,
    tools,
    workerId: 'w1',
    pollMs: 20,
    onRunSettled: async () => {
      attempts++
      throw new Error('webhook enqueue failed')
    },
  })
  await waitFor(() => attempts === 1)
  await worker.stop()
  expect(await queueRows()).toBe(1)
  expect(await runStatus('r8')).toBe('completed')
})

// An LLM that asks for an unknown tool, so a second LLM step would follow unless the run is aborted.
function toolCallingLlm(onFirstCall: () => Promise<void>): LLMPort & { calls: number } {
  const port = {
    calls: 0,
    complete: async () => {
      port.calls++
      if (port.calls === 1) await onFirstCall()
      return {
        message: { role: 'assistant' as const, content: '', toolCalls: [{ id: `c${port.calls}`, name: 'ghost', arguments: {} }] },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'tool_calls' as const,
      }
    },
  }
  return port
}

test('a lost lock aborts the run: no failure, no release, no settle', async () => {
  const { version } = await new ConfigRepo(pool, 'default', box).putAgent(agent)
  await seedRun('r9', 'helper', version)
  const slow = toolCallingLlm(async () => {
    await pool.query("UPDATE queue SET locked_by = 'w2' WHERE run_id = 'r9'")
    await new Promise((r) => setTimeout(r, 250))
  })
  const settled: string[] = []
  const worker = startRunWorker({
    secrets: box,
    pool,
    llm: slow,
    tools,
    workerId: 'w1',
    pollMs: 20,
    heartbeatMs: 30,
    onRunSettled: async (id) => {
      settled.push(id)
    },
  })
  await waitFor(() => slow.calls >= 1)
  await new Promise((r) => setTimeout(r, 500))
  await worker.stop()
  expect(slow.calls).toBe(1)
  expect(settled).toEqual([])
  const rows = await pool.query('SELECT locked_by FROM queue WHERE run_id = $1', ['r9'])
  expect(rows.rows).toEqual([{ locked_by: 'w2' }])
  const types = (await new PgRunStore(pool, 'default').readEvents('r9')).map((e) => e.type)
  expect(types).not.toContain('error.raised')
})

test('stop aborts the in-flight run and puts the job back for another worker', async () => {
  const { version } = await new ConfigRepo(pool, 'default', box).putAgent(agent)
  await seedRun('r10', 'helper', version)
  let open!: () => void
  const gate = new Promise<void>((r) => (open = r))
  const slow = toolCallingLlm(() => gate)
  const settled: string[] = []
  const worker = startRunWorker({
    secrets: box,
    pool,
    llm: slow,
    tools,
    workerId: 'w1',
    pollMs: 20,
    onRunSettled: async (id) => {
      settled.push(id)
    },
  })
  await waitFor(() => slow.calls === 1)
  const stopping = worker.stop()
  open()
  await stopping
  expect(slow.calls).toBe(1)
  expect(settled).toEqual([])
  const rows = await pool.query('SELECT locked_by, available_at <= now() AS due FROM queue WHERE run_id = $1', ['r10'])
  expect(rows.rows).toEqual([{ locked_by: null, due: true }])
  expect(await runStatus('r10')).toBe('running')
})

test('a worker whose lock was taken writes nothing and does not fail, settle or release the run', async () => {
  await new ConfigRepo(pool, 'default', box).putAgent({ ...agent, model: 'default' })
  await seedRun('r-lost', 'helper', 1)
  const settled: string[] = []
  const worker = startRunWorker({
    secrets: box,
    pool,
    llm,
    tools,
    workerId: 'w1',
    pollMs: 20,
    loadContext: async () => {
      await pool.query("UPDATE queue SET locked_by = 'w2' WHERE run_id = 'r-lost'") // w2 takes the job
      return { agent, agentVersion: 1, toolsByName: {} }
    },
    onRunSettled: async (id) => {
      settled.push(id)
    },
  })
  await new Promise((r) => setTimeout(r, 400))
  await worker.stop()
  expect(settled).toEqual([])
  expect((await new PgRunStore(pool, 'default').readEvents('r-lost')).map((e) => e.type)).toEqual(['run.created'])
  expect((await pool.query('SELECT locked_by FROM queue')).rows).toEqual([{ locked_by: 'w2' }])
})

class RetryableLlmError extends Error {
  readonly retryable = true
}

test('a retryable LLM error re-enqueues the run at retryAt without failing or settling it', async () => {
  const { version } = await new ConfigRepo(pool, 'default', box).putAgent(agent)
  await seedRun('r11', 'helper', version)
  const failing: LLMPort = {
    complete: async () => {
      throw new RetryableLlmError('provider busy')
    },
  }
  const settled: string[] = []
  const worker = startRunWorker({
    secrets: box,
    pool,
    llm: failing,
    tools,
    workerId: 'w1',
    pollMs: 20,
    onRunSettled: async (id) => {
      settled.push(id)
    },
  })
  const store = new PgRunStore(pool, 'default')
  let retryAt: string | undefined
  await waitFor(() => {
    void store.readEvents('r11').then((events) => {
      const wait = events.find((e) => e.type === 'error.raised' && (e.payload as { retryAt?: string }).retryAt !== undefined)
      retryAt = (wait?.payload as { retryAt?: string } | undefined)?.retryAt
    })
    return retryAt !== undefined
  })
  await new Promise((r) => setTimeout(r, 200))
  await worker.stop()
  expect(settled).toEqual([])
  expect(await runStatus('r11')).toBe('running')
  const rows = await pool.query<{ locked_by: string | null; available_at: Date }>(
    'SELECT locked_by, available_at FROM queue WHERE run_id = $1',
    ['r11'],
  )
  expect(rows.rows).toHaveLength(1)
  expect(rows.rows[0]?.locked_by).toBeNull()
  expect(rows.rows[0]?.available_at.getTime()).toBe(new Date(retryAt!).getTime())
})

// Seeds the log of a run whose worker died right after `tool.requested` for call_1.
async function seedInFlight(runId: string, versionNo: number, toolName: string): Promise<void> {
  await createRun(pool, { tenantId: 'default', runId, agentId: 'helper', agentVersion: versionNo, input: { text: 'hi' } })
  await new PgRunStore(pool, 'default').append(runId, [
    { type: 'run.created', payload: { agentId: 'helper', input: { text: 'hi' } }, labels: ['trusted'] },
    { type: 'run.state_changed', payload: { from: 'queued', to: 'running' }, labels: [] },
    {
      type: 'llm.responded',
      payload: {
        message: { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: toolName, arguments: {} }] },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'tool_calls',
      },
      labels: [],
    },
    {
      type: 'tool.requested',
      payload: { toolCallId: 'call_1', tool: toolName, args: {}, idempotencyKey: `${runId}:call_1` },
      labels: [],
    },
  ])
  await enqueue(pool, { runId, tenantId: 'default' })
}

const writeTool = (idempotency: boolean) => ({
  name: 'pay',
  description: 'd',
  inputSchema: {},
  safety: { effect: 'write' as const, idempotency, reachesOutside: true, outputLabel: 'trusted' as const },
  connectionId: 'c1',
  source: {},
  confirmed: {},
})

function recordingTools(): ToolInvoker & { keys: string[] } {
  const port = {
    keys: [] as string[],
    call: async (_tool: unknown, _args: unknown, ctx: { idempotencyKey: string }) => {
      port.keys.push(ctx.idempotencyKey)
      return { content: 'ok', isError: false }
    },
  }
  return port
}

test('a run resumed after tool.requested calls a keyed write again with the same key', async () => {
  const { version } = await new ConfigRepo(pool, 'default', box).putAgent(agent)
  await seedInFlight('r12', version, 'pay')
  const recorder = recordingTools()
  const settled: Array<[string, RunStatus]> = []
  const worker = startRunWorker({
    secrets: box,
    pool,
    llm,
    tools: () => recorder,
    workerId: 'w1',
    pollMs: 20,
    loadContext: async () => ({ agent, agentVersion: version, toolsByName: { pay: writeTool(true) } }),
    onRunSettled: async (id, _tenantId, status) => {
      settled.push([id, status])
    },
  })
  await waitFor(() => settled.length === 1)
  await worker.stop()
  expect(recorder.keys).toEqual(['r12:call_1'])
  expect(settled).toEqual([['r12', 'completed']])
  expect(await runStatus('r12')).toBe('completed')
})

test('a run resumed after tool.requested for an unkeyed write waits for a human', async () => {
  const { version } = await new ConfigRepo(pool, 'default', box).putAgent(agent)
  await seedInFlight('r13', version, 'pay')
  const recorder = recordingTools()
  const settled: Array<[string, RunStatus]> = []
  const worker = startRunWorker({
    secrets: box,
    pool,
    llm,
    tools: () => recorder,
    workerId: 'w1',
    pollMs: 20,
    loadContext: async () => ({ agent, agentVersion: version, toolsByName: { pay: writeTool(false) } }),
    onRunSettled: async (id, _tenantId, status) => {
      settled.push([id, status])
    },
  })
  await waitFor(() => settled.length === 1)
  await worker.stop()
  expect(recorder.keys).toEqual([])
  expect(settled).toEqual([['r13', 'waiting_human']])
  const row = await pool.query('SELECT status, waiting_reason FROM runs WHERE id = $1', ['r13'])
  expect(row.rows).toEqual([{ status: 'waiting_human', waiting_reason: 'unknown_outcome' }])
})

async function seedTenantRun(tenantId: string, runId: string, versionNo: number): Promise<void> {
  await createRun(pool, { tenantId, runId, agentId: 'helper', agentVersion: versionNo, input: { text: 'hi' } })
  await new PgRunStore(pool, tenantId).append(runId, [
    { type: 'run.created', payload: { agentId: 'helper', input: { text: 'hi' } }, labels: ['trusted'] },
  ])
  await enqueue(pool, { runId, tenantId })
}

test("a run of b whose agent names a connection that only a has fails with connection not found and never calls a's tool", async () => {
  await createTenant(pool, 'a')
  await createTenant(pool, 'b')
  const tool = {
    name: 'shop.get',
    description: 'd',
    inputSchema: {},
    safety: { effect: 'read' as const, idempotency: true, reachesOutside: false, outputLabel: 'trusted' as const },
    connectionId: 'shop',
    source: {},
    confirmed: {},
  }
  await new ConfigRepo(pool, 'a', box).putConnection({ id: 'shop', kind: 'mcp', url: 'http://x', tools: [tool] })
  const { version } = await new ConfigRepo(pool, 'b', box).putAgent({ ...agent, connections: ['shop'] })
  await seedTenantRun('b', 'rb1', version)
  const asked: string[] = []
  const recorder = recordingTools()
  const settled: Array<[string, string, RunStatus]> = []
  const worker = startRunWorker({
    secrets: box,
    pool,
    llm,
    tools: (tenantId) => {
      asked.push(tenantId)
      return recorder
    },
    workerId: 'w1',
    pollMs: 20,
    onRunSettled: async (id, tenantId, status) => {
      settled.push([id, tenantId, status])
    },
  })
  await waitFor(() => settled.length === 1)
  await worker.stop()
  expect(settled).toEqual([['rb1', 'b', 'failed']])
  const events = await new PgRunStore(pool, 'b').readEvents('rb1')
  expect(events.find((e) => e.type === 'error.raised')?.payload).toMatchObject({ message: 'connection not found: shop' })
  expect(asked.filter((t) => t !== 'b')).toEqual([])
  expect(recorder.keys).toEqual([])
})

test("onRunSettled receives the run's tenant", async () => {
  await createTenant(pool, 'a')
  const { version } = await new ConfigRepo(pool, 'a', box).putAgent(agent)
  await seedTenantRun('a', 'ra1', version)
  const settled: Array<[string, string, RunStatus]> = []
  const worker = startRunWorker({
    secrets: box,
    pool,
    llm,
    tools,
    workerId: 'w1',
    pollMs: 20,
    onRunSettled: async (id, tenantId, status) => {
      settled.push([id, tenantId, status])
    },
  })
  await waitFor(() => settled.length === 1)
  await worker.stop()
  expect(settled).toEqual([['ra1', 'a', 'completed']])
})

test('a connection secret that cannot be decrypted fails the run once and does not retry', async () => {
  const config = new ConfigRepo(pool, 'default', box)
  await config.putConnection({ id: 'hook', kind: 'webhook', url: 'http://h/x', secret: 'plain-secret', tools: [] })
  const { version } = await config.putAgent({ ...agent, connections: ['hook'] })
  await seedRun('rd1', 'helper', version)
  const settled: Array<[string, RunStatus]> = []
  const worker = startRunWorker({
    secrets: createSecretBox(Buffer.alloc(32, 9)), // another master key: the stored secret does not open
    pool,
    llm,
    tools,
    workerId: 'w1',
    pollMs: 20,
    onRunSettled: async (id, _tenantId, status) => {
      settled.push([id, status])
    },
  })
  await waitFor(() => settled.length === 1)
  await worker.stop()
  expect(settled).toEqual([['rd1', 'failed']])
  expect(await queueRows()).toBe(0)
  const events = await new PgRunStore(pool, 'default').readEvents('rd1')
  const raised = events.find((e) => e.type === 'error.raised')
  expect(raised?.payload).toMatchObject({ message: 'connection secret could not be decrypted: hook', retryable: false })
  expect(JSON.stringify(events)).not.toContain('plain-secret')
})
