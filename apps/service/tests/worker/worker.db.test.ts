import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import type { AgentDefinition, LLMPort, RunStatus, ToolInvoker } from '@agent-core/core'
import { ConfigRepo, PgRunStore, assertTestDatabase, createPool, createRun, createTenant, enqueue, getRun, makeDue, runMigrations } from '@agent-core/store-postgres'
import { startRunWorker } from '../../src/worker/worker'
import type { RunWorkerDeps } from '../../src/worker/worker'
import { createSecretBox, toolFingerprint } from '@agent-core/core'

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

test('a cancel input sent while the run waits for an LLM retry stops it at once, not at retryAt', async () => {
  const { version } = await new ConfigRepo(pool, 'default', box).putAgent(agent)
  await seedRun('r-cx', 'helper', version)
  const failing: LLMPort = {
    complete: async () => {
      throw new RetryableLlmError('provider busy')
    },
  }
  const settled: RunStatus[] = []
  const worker = startRunWorker({
    secrets: box,
    pool,
    llm: failing,
    tools,
    workerId: 'w1',
    pollMs: 20,
    onRunSettled: async (_id, _t, status) => {
      settled.push(status)
    },
  })
  const store = new PgRunStore(pool, 'default')
  let waiting = false
  await waitFor(() => {
    void store.readEvents('r-cx').then((events) => {
      waiting = events.some((e) => e.type === 'error.raised')
    })
    return waiting
  })
  await store.append('r-cx', [{ type: 'input.received', payload: { action: 'cancel' }, labels: [] }])
  await makeDue(pool, 'default', 'r-cx')
  await waitFor(() => settled.includes('cancelled'))
  await worker.stop()
  expect(await runStatus('r-cx')).toBe('cancelled')
  expect(await queueRows()).toBe(0)
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

const settledLog = () => {
  const settled: Array<[string, RunStatus]> = []
  return { settled, onRunSettled: async (id: string, _t: string, status: RunStatus) => void settled.push([id, status]) }
}
const queueDueAt = async (runId: string): Promise<Date | undefined> =>
  (await pool.query<{ available_at: Date }>('SELECT available_at FROM queue WHERE run_id = $1', [runId])).rows[0]?.available_at

test('a tenant over its daily cost pauses a new run before its first LLM call and keeps the job for the wait expiry', async () => {
  const { version } = await new ConfigRepo(pool, 'default', box).putAgent(agent)
  await seedRun('spent', 'helper', version)
  await new PgRunStore(pool, 'default').append('spent', [
    {
      type: 'llm.responded',
      payload: { message: { role: 'assistant', content: 'x' }, usage: { inputTokens: 1, outputTokens: 1, costUsd: 25 }, stopReason: 'end' },
      labels: [],
    },
  ])
  await pool.query('DELETE FROM queue')
  await seedRun('r-cost', 'helper', version)
  let llmCalls = 0
  const countingLlm: LLMPort = { complete: async (req) => (llmCalls++, llm.complete(req)) }
  const log = settledLog()
  const worker = startRunWorker({ secrets: box, pool, llm: countingLlm, tools, workerId: 'w1', pollMs: 20, ...log })
  await waitFor(() => log.settled.length === 1)
  await worker.stop()
  expect(log.settled).toEqual([['r-cost', 'waiting_human']])
  expect(llmCalls).toBe(0)
  const events = await new PgRunStore(pool, 'default').readEvents('r-cost')
  expect(events.at(-2)!.payload).toMatchObject({ limit: 'tenant_cost_usd_per_day', max: 20, value: 25 })
  const expiresAt = (events.at(-1)!.payload as { expiresAt: string }).expiresAt
  expect((await queueDueAt('r-cost'))?.toISOString()).toBe(expiresAt)
})

test('a job claimed after the wait expired fails the run with reason wait_expired', async () => {
  const { version } = await new ConfigRepo(pool, 'default', box).putAgent(agent)
  await seedRun('r-exp', 'helper', version)
  await new PgRunStore(pool, 'default').append('r-exp', [
    { type: 'run.state_changed', payload: { from: 'queued', to: 'running' }, labels: [] },
    {
      type: 'run.state_changed',
      payload: { from: 'running', to: 'waiting_human', reason: 'approval', expiresAt: new Date(Date.now() - 1000).toISOString() },
      labels: [],
    },
  ])
  const log = settledLog()
  const worker = startRunWorker({ secrets: box, pool, llm, tools, workerId: 'w1', pollMs: 20, ...log })
  await waitFor(() => log.settled.length === 1)
  await worker.stop()
  expect(log.settled).toEqual([['r-exp', 'failed']])
  const events = await new PgRunStore(pool, 'default').readEvents('r-exp')
  expect(events.at(-2)).toMatchObject({ type: 'limit.reached', payload: { limit: 'wait_human_s' } })
  expect(events.at(-1)!.payload).toEqual({ from: 'waiting_human', to: 'failed', reason: 'wait_expired' })
  expect(await queueRows()).toBe(0)
})

test('a job claimed before the wait expires changes nothing and is put back for the expiry', async () => {
  const { version } = await new ConfigRepo(pool, 'default', box).putAgent(agent)
  await seedRun('r-early', 'helper', version)
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
  await new PgRunStore(pool, 'default').append('r-early', [
    { type: 'run.state_changed', payload: { from: 'queued', to: 'running' }, labels: [] },
    { type: 'run.state_changed', payload: { from: 'running', to: 'waiting_human', reason: 'approval', expiresAt }, labels: [] },
  ])
  const before = (await new PgRunStore(pool, 'default').readEvents('r-early')).length
  const log = settledLog()
  const worker = startRunWorker({ secrets: box, pool, llm, tools, workerId: 'w1', pollMs: 20, ...log })
  await waitFor(() => log.settled.length === 1)
  await worker.stop()
  expect((await new PgRunStore(pool, 'default').readEvents('r-early')).length).toBe(before)
  expect((await queueDueAt('r-early'))?.toISOString()).toBe(expiresAt)
})

test('a wait that is nearly due is put back at least 1 s ahead, so clock skew cannot spin the job', async () => {
  const { version } = await new ConfigRepo(pool, 'default', box).putAgent(agent)
  await seedRun('r-skew', 'helper', version)
  await new PgRunStore(pool, 'default').append('r-skew', [
    { type: 'run.state_changed', payload: { from: 'queued', to: 'running' }, labels: [] },
    {
      type: 'run.state_changed',
      payload: { from: 'running', to: 'waiting_human', reason: 'approval', expiresAt: new Date(Date.now() + 300).toISOString() },
      labels: [],
    },
  ])
  const log = settledLog()
  const worker = startRunWorker({ secrets: box, pool, llm, tools, workerId: 'w1', pollMs: 20, ...log })
  await waitFor(() => log.settled.length === 1)
  const settledAt = Date.now()
  await worker.stop()
  expect(log.settled).toEqual([['r-skew', 'waiting_human']])
  expect((await queueDueAt('r-skew'))!.getTime()).toBeGreaterThanOrEqual(settledAt + 500)
})

const followupAgent: AgentDefinition = { ...agent, allow: [{ tool: 'agent_core.schedule_followup' }] }
/** First asks for a follow-up in an hour, then answers. */
function followupLlm(): LLMPort & { requests: Parameters<LLMPort['complete']>[0][] } {
  const requests: Parameters<LLMPort['complete']>[0][] = []
  return {
    requests,
    complete: async (req) => {
      requests.push(req)
      return requests.length === 1
        ? {
            message: { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'agent_core.schedule_followup', arguments: { after_seconds: 3600, note: 'check again' } }] },
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: 'tool_calls',
          }
        : { message: { role: 'assistant', content: 'checked' }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end' }
    },
  }
}

test('a sleeping run is settled and keeps its job, unlocked and due at its wake time', async () => {
  const { version } = await new ConfigRepo(pool, 'default', box).putAgent(followupAgent)
  await seedRun('r-sleep', 'helper', version)
  const log = settledLog()
  const worker = startRunWorker({ secrets: box, pool, llm: followupLlm(), tools, workerId: 'w1', pollMs: 20, ...log })
  await waitFor(() => log.settled.length === 1)
  await worker.stop()
  expect(log.settled).toEqual([['r-sleep', 'sleeping']])
  const events = await new PgRunStore(pool, 'default').readEvents('r-sleep')
  const wakeAt = (events.at(-1)!.payload as { wakeAt: string }).wakeAt
  expect(Date.parse(wakeAt) - Date.now()).toBeGreaterThan(3_590_000)
  const row = (await pool.query<{ locked_by: string | null; available_at: Date }>('SELECT locked_by, available_at FROM queue WHERE run_id = $1', ['r-sleep'])).rows[0]
  expect(row?.locked_by).toBeNull()
  expect(row?.available_at.toISOString()).toBe(wakeAt)
})

test('a follow-up survives a worker restart and wakes the run when due', async () => {
  // The store stamps events with the real time and the second worker's clock is an hour ahead, so the
  // run time it measures includes the sleep. Room for that keeps the test about the wake-up.
  const { version } = await new ConfigRepo(pool, 'default', box).putAgent({ ...followupAgent, limits: { run_time_s: 7200 } })
  await seedRun('r-wake', 'helper', version)
  const llm = followupLlm()
  const first = settledLog()
  const w1 = startRunWorker({ secrets: box, pool, llm, tools, workerId: 'w1', pollMs: 20, ...first })
  await waitFor(() => first.settled.length === 1)
  await w1.stop()
  expect(await runStatus('r-wake')).toBe('sleeping')

  // A new worker an hour later: its clock is past the wake time, and the job is due.
  const later = () => new Date(Date.now() + 3_601_000)
  await pool.query('UPDATE queue SET available_at = now() WHERE run_id = $1', ['r-wake'])
  const second = settledLog()
  const w2 = startRunWorker({ secrets: box, pool, llm, tools, workerId: 'w2', pollMs: 20, now: later, ...second })
  await waitFor(() => second.settled.length === 1)
  await w2.stop()
  expect(second.settled).toEqual([['r-wake', 'completed']])
  expect(llm.requests.at(-1)!.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'c1', content: expect.stringMatching(/^Follow-up at .+\. Note: check again$/) })
  expect(await queueRows()).toBe(0)
})

test('a call over its connection rate is deferred and the job comes back at retryAt, unsettled', async () => {
  const config = new ConfigRepo(pool, 'default', box)
  // ConfigRepo recomputes safety from the declared source, so the read effect is declared, confirmed and reviewed.
  const safety = { ...writeTool(true).safety, effect: 'read' as const }
  const declared = { ...writeTool(true), name: 'lookup', safety, source: { declared: safety }, confirmed: safety }
  const lookup = { ...declared, reviewedFor: toolFingerprint(declared) }
  await config.putConnection({ id: 'c1', kind: 'webhook', url: 'http://c1.test', secret: 's', tools: [lookup], limits: { calls_per_minute: 1 } })
  const { version } = await config.putAgent({ ...agent, connections: ['c1'] })
  await seedRun('r-rate', 'helper', version)
  let turn = 0
  const twoLookups: LLMPort = {
    complete: async () => ({
      message: { role: 'assistant', content: '', toolCalls: [{ id: `c${++turn}`, name: 'lookup', arguments: { n: turn } }] },
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: 'tool_calls',
    }),
  }
  const recorder = recordingTools()
  const log = settledLog()
  const worker = startRunWorker({ secrets: box, pool, llm: twoLookups, tools: () => recorder, workerId: 'w1', pollMs: 20, ...log })
  const store = new PgRunStore(pool, 'default')
  let deferred: { reason: string; retryAt: string } | undefined
  await waitFor(() => {
    void store.readEvents('r-rate').then((events) => {
      deferred = events.find((e) => e.type === 'tool.deferred')?.payload as typeof deferred
    })
    return deferred !== undefined
  })
  await new Promise((r) => setTimeout(r, 200))
  await worker.stop()
  expect(deferred?.reason).toBe('rate')
  expect(recorder.keys).toEqual(['r-rate:c1'])
  expect(log.settled).toEqual([])
  expect(await runStatus('r-rate')).toBe('running')
  const row = (await pool.query<{ locked_by: string | null; available_at: Date }>('SELECT locked_by, available_at FROM queue WHERE run_id = $1', ['r-rate'])).rows[0]
  expect(row?.locked_by).toBeNull()
  expect(row?.available_at.toISOString()).toBe(deferred?.retryAt)
})
