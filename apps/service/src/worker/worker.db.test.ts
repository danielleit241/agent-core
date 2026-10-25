import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import type { AgentDefinition, LLMPort, RunStatus, ToolInvoker } from '@agent-core/core'
import { ConfigRepo, PgRunStore, assertTestDatabase, createPool, createRun, enqueue, getRun, runMigrations } from '@agent-core/store-postgres'
import { startRunWorker } from './worker'
import type { RunWorkerDeps } from './worker'

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
const tools: ToolInvoker = {
  call: async () => {
    throw new Error('no tools expected')
  },
}
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
  const { version } = await new ConfigRepo(pool, 'default').putAgent(agent)
  await seedRun('r1', 'helper', version)
  const settled: Array<[string, RunStatus]> = []
  const worker = startRunWorker({
    pool,
    llm,
    tools,
    workerId: 'w1',
    pollMs: 20,
    onRunSettled: async (id, status) => {
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
    pool,
    llm,
    tools,
    workerId: 'w1',
    pollMs: 20,
    onRunSettled: async (id, status) => {
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
  const worker = startRunWorker({ pool, llm, tools, workerId: 'w1', pollMs: 20 })
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
    pool,
    llm,
    tools,
    workerId: 'w1',
    pollMs: 20,
    onRunSettled: async (id, status) => {
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
  const config = new ConfigRepo(pool, 'default')
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
    pool,
    llm,
    tools,
    workerId: 'w1',
    pollMs: 20,
    onRunSettled: async (id, status) => {
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
  const { version } = await new ConfigRepo(pool, 'default').putAgent(agent)
  await seedRun('r5', 'helper', version)
  const settled: string[] = []
  const loadContext: RunWorkerDeps['loadContext'] = async () => {
    throw new Error('connection reset')
  }
  const worker = startRunWorker({
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
  const { version } = await new ConfigRepo(pool, 'default').putAgent(agent)
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
  const config = new ConfigRepo(pool, 'default')
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
    pool,
    llm,
    tools,
    workerId: 'w1',
    pollMs: 20,
    onRunSettled: async (id, status) => {
      settled.push([id, status])
    },
  })
  await waitFor(() => settled.length === 1)
  await worker.stop()
  expect(settled).toEqual([['r7', 'completed']])
})

test('when onRunSettled fails the queue row stays so the job is retried', async () => {
  const { version } = await new ConfigRepo(pool, 'default').putAgent(agent)
  await seedRun('r8', 'helper', version)
  let attempts = 0
  const worker = startRunWorker({
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
  const { version } = await new ConfigRepo(pool, 'default').putAgent(agent)
  await seedRun('r9', 'helper', version)
  const slow = toolCallingLlm(async () => {
    await pool.query("UPDATE queue SET locked_by = 'w2' WHERE run_id = 'r9'")
    await new Promise((r) => setTimeout(r, 250))
  })
  const settled: string[] = []
  const worker = startRunWorker({
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
  const { version } = await new ConfigRepo(pool, 'default').putAgent(agent)
  await seedRun('r10', 'helper', version)
  let open!: () => void
  const gate = new Promise<void>((r) => (open = r))
  const slow = toolCallingLlm(() => gate)
  const settled: string[] = []
  const worker = startRunWorker({
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
  await new ConfigRepo(pool, 'default').putAgent({ ...agent, model: 'default' })
  await seedRun('r-lost', 'helper', 1)
  const settled: string[] = []
  const worker = startRunWorker({
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
