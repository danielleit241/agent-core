import { advanceRun, projectRun } from '@agent-core/core'
import type { AgentDefinition, LLMPort, RunStatus, ToolDescriptor, ToolInvoker } from '@agent-core/core'
import {
  ConfigRepo,
  LockLostError,
  PgRunStore,
  claim,
  createPool,
  enqueue,
  getRun,
  heartbeat,
  release,
  requeueIfHolder,
} from '@agent-core/store-postgres'

type Pool = ReturnType<typeof createPool>

export type RunContext = { agent: AgentDefinition; agentVersion: number; toolsByName: Record<string, ToolDescriptor> }

export type RunWorkerDeps = {
  pool: Pool
  llm: LLMPort
  tools: ToolInvoker
  workerId: string
  pollMs?: number
  /** Running jobs allowed per tenant; defaults to `DEFAULT_MAX_RUNS_PER_TENANT`. */
  maxRunsPerTenant?: number
  /** Must stay well below the 300000 ms lock timeout used by `claim`. */
  heartbeatMs?: number
  /** Replaces the default loader; used by tests to simulate load errors. */
  loadContext?: (runId: string, tenantId: string) => Promise<RunContext>
  onRunSettled?: (runId: string, status: RunStatus) => Promise<void>
}

const RETRY_DELAY_MS = 5000
const MIN_REQUEUE_DELAY_MS = 1000
const TERMINAL: readonly RunStatus[] = ['completed', 'failed', 'cancelled']

/** A permanent problem with the run's configuration: retrying cannot help. */
export class ConfigError extends Error {}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

async function loadContext(pool: Pool, runId: string, tenantId: string): Promise<RunContext> {
  const run = await getRun(pool, tenantId, runId)
  if (!run) throw new ConfigError(`run not found: ${runId}`)
  const config = new ConfigRepo(pool, tenantId)
  const agent = await config.getAgent(run.agentId)
  if (!agent) throw new ConfigError(`agent not found: ${run.agentId}`)
  // No prototype: a tool named `toString` must not collide with inherited members.
  const toolsByName: Record<string, ToolDescriptor> = Object.create(null)
  for (const connectionId of agent.definition.connections) {
    const connection = await config.getConnection(connectionId)
    if (!connection) throw new ConfigError(`connection not found: ${connectionId}`)
    for (const tool of connection.tools) {
      if (Object.hasOwn(toolsByName, tool.name)) throw new ConfigError(`duplicate tool name: ${tool.name}`)
      toolsByName[tool.name] = tool
    }
  }
  return { agent: agent.definition, agentVersion: agent.version, toolsByName }
}

/** Records the failure. Returns the settled status, or null when the failure could not be recorded. */
async function failRun(deps: RunWorkerDeps, runId: string, tenantId: string, err: unknown): Promise<RunStatus | null> {
  try {
    const current = (await getRun(deps.pool, tenantId, runId))?.status
    if (current && TERMINAL.includes(current)) {
      console.error(`worker: run ${runId} is already ${current}; not recording`, err)
      return current
    }
    await new PgRunStore(deps.pool, tenantId, { lockedBy: deps.workerId }).append(runId, [
      { type: 'error.raised', payload: { message: errorMessage(err), retryable: false }, labels: [] },
      { type: 'run.state_changed', payload: { from: current ?? 'running', to: 'failed' }, labels: [] },
    ])
    return 'failed'
  } catch (appendErr) {
    console.error(`worker: could not record failure of run ${runId}`, appendErr)
    return null
  }
}

/** Why the job's signal was aborted: this worker lost the lock, or the service is shutting down. */
type JobControl = { abort: AbortController; reason?: 'lock_lost' | 'shutdown' }

async function processJob(deps: RunWorkerDeps, job: { runId: string; tenantId: string }, ctl: JobControl): Promise<void> {
  const { runId, tenantId } = job
  const beat = setInterval(() => {
    heartbeat(deps.pool, runId, deps.workerId)
      .then((held) => {
        if (!held && !ctl.abort.signal.aborted) {
          ctl.reason = 'lock_lost'
          ctl.abort.abort()
        }
      })
      .catch((err: unknown) => console.error(`worker: heartbeat failed for run ${runId}`, err))
  }, deps.heartbeatMs ?? 60000)
  let status: RunStatus | null
  try {
    let ctx: RunContext
    try {
      ctx = await (deps.loadContext ?? ((r, t) => loadContext(deps.pool, r, t)))(runId, tenantId)
    } catch (err) {
      if (!(err instanceof ConfigError)) {
        // Transient: put the job back, unlocked, and retry later. The run is not failed.
        console.error(`worker: transient error loading run ${runId}; retrying`, err)
        try {
          await enqueue(deps.pool, { runId, tenantId, availableAt: new Date(Date.now() + RETRY_DELAY_MS) })
        } catch (enqueueErr) {
          console.error(`worker: could not re-enqueue run ${runId}; the lock will expire`, enqueueErr)
        }
        return
      }
      throw err
    }
    status = await advanceRun(runId, {
      store: new PgRunStore(deps.pool, tenantId, { lockedBy: deps.workerId }),
      llm: deps.llm,
      tools: deps.tools,
      ...ctx,
      signal: ctl.abort.signal,
    })
  } catch (err) {
    if (err instanceof LockLostError && !ctl.abort.signal.aborted) {
      ctl.reason = 'lock_lost'
      ctl.abort.abort()
    }
    // After an abort the error is a side effect of stopping; do not fail the run for it.
    status = ctl.abort.signal.aborted ? null : await failRun(deps, runId, tenantId, err)
  } finally {
    clearInterval(beat)
  }
  if (ctl.abort.signal.aborted) {
    if (ctl.reason === 'shutdown') {
      // Hand the job to another worker now: unlock the row and make it due, only if this worker still holds it.
      try {
        await requeueIfHolder(deps.pool, runId, deps.workerId)
      } catch (err) {
        console.error(`worker: could not re-enqueue run ${runId}; the lock will expire`, err)
      }
    }
    return // lost lock: the new holder owns the job
  }
  if (status === null) return // lock expires, the run is retried later
  if (status === 'running') {
    // The run waits for an LLM retry. Put the job back, unlocked, for when the retry is due: no settle, no release.
    try {
      const events = await new PgRunStore(deps.pool, tenantId, { lockedBy: deps.workerId }).readEvents(runId)
      const proj = projectRun(events, '')
      if (proj.status === 'running') {
        const now = Date.now()
        const retryAt = proj.llmRetry.retryAt === null ? Number.NaN : new Date(proj.llmRetry.retryAt).getTime()
        const dueAt = Number.isNaN(retryAt) ? now + RETRY_DELAY_MS : Math.max(retryAt, now + MIN_REQUEUE_DELAY_MS)
        await requeueIfHolder(deps.pool, runId, deps.workerId, new Date(dueAt))
        return
      }
      status = proj.status
    } catch (err) {
      console.error(`worker: could not re-enqueue run ${runId}; the lock will expire`, err)
      return
    }
  }
  // Settle before release: when settling fails the row stays locked, the lock expires and the job
  // runs again. The settle step is idempotent, so the repeat is safe.
  try {
    await deps.onRunSettled?.(runId, status)
  } catch (err) {
    console.error(`worker: onRunSettled failed for run ${runId}; the job will be retried`, err)
    return
  }
  try {
    await release(deps.pool, runId, deps.workerId)
  } catch (err) {
    console.error(`worker: could not release run ${runId}`, err)
  }
}

/** Polls the queue until `stop()`. `stop()` waits for the job in progress and does not close the pool. */
export function startRunWorker(deps: RunWorkerDeps): { stop(): Promise<void> } {
  const pollMs = deps.pollMs ?? 200
  let stopping = false
  let current: JobControl | undefined
  const loop = (async () => {
    while (!stopping) {
      let job: { runId: string; tenantId: string } | null = null
      try {
        job = await claim(deps.pool, deps.workerId, { maxPerTenant: deps.maxRunsPerTenant })
      } catch (err) {
        console.error('worker: claim failed', err)
      }
      if (!job) {
        await new Promise((resolve) => setTimeout(resolve, pollMs))
        continue
      }
      const ctl: JobControl = { abort: new AbortController() }
      current = ctl
      if (stopping) {
        ctl.reason = 'shutdown'
        ctl.abort.abort()
      }
      try {
        await processJob(deps, job, ctl)
      } finally {
        current = undefined
      }
    }
  })()
  return {
    async stop() {
      stopping = true
      if (current && !current.abort.signal.aborted) {
        current.reason = 'shutdown'
        current.abort.abort()
      }
      await loop
    },
  }
}
