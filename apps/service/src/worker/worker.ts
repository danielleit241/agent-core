import { SecretDecryptError, advance, expireWait, projectRun } from '@agent-core/core'
import type { AgentDefinition, ConnectionGuard, ConnectionLimits, LLMPort, RunStatus, SecretBox, ToolDescriptor, ToolInvoker } from '@agent-core/core'
import { resolveAgent } from '../default-agent'
import { createSubruns } from '../runs/subruns'
import {
  ConfigRepo,
  LockLostError,
  PgConnectionGuard,
  PgRunStore,
  StateConflictError,
  claim,
  createPool,
  enqueue,
  getRun,
  heartbeat,
  makeDue,
  release,
  requeueIfHolder,
} from '@agent-core/store-postgres'

type Pool = ReturnType<typeof createPool>

const startOfUtcDay = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))

export type RunContext = {
  agent: AgentDefinition
  agentVersion: number
  toolsByName: Record<string, ToolDescriptor>
  guard?: ConnectionGuard
}

export type RunWorkerDeps = {
  pool: Pool
  secrets: SecretBox
  llm: LLMPort
  /** Gives the invoker for one tenant's tools. */
  tools: (tenantId: string) => ToolInvoker
  workerId: string
  pollMs?: number
  /** Running jobs allowed per tenant; defaults to `DEFAULT_MAX_RUNS_PER_TENANT`. */
  maxRunsPerTenant?: number
  /** Must stay well below the 300000 ms lock timeout used by `claim`. */
  heartbeatMs?: number
  /** Replaces the default loader; used by tests to simulate load errors. */
  loadContext?: (runId: string, tenantId: string) => Promise<RunContext>
  onRunSettled?: (runId: string, tenantId: string, status: RunStatus) => Promise<void>
  /** Clock for the runner. Tests inject one that is past a follow-up's wake time. */
  now?: () => Date
}

const RETRY_DELAY_MS = 5000
const MIN_REQUEUE_DELAY_MS = 1000
// A run that sleeps on a child run is checked this often; the child's end also makes it due at once.
const SUBRUN_POLL_MS = 60_000
const TERMINAL: readonly RunStatus[] = ['completed', 'failed', 'cancelled']

/** A permanent problem with the run's configuration: retrying cannot help. */
export class ConfigError extends Error {}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

async function loadContext(pool: Pool, secrets: SecretBox, runId: string, tenantId: string): Promise<RunContext> {
  const run = await getRun(pool, tenantId, runId)
  if (!run) throw new ConfigError(`run not found: ${runId}`)
  const config = new ConfigRepo(pool, tenantId, secrets)
  const agent = await resolveAgent(config, run.agentId)
  if (!agent) throw new ConfigError(`agent not found: ${run.agentId}`)
  // No prototype: a tool named `toString` must not collide with inherited members.
  const toolsByName: Record<string, ToolDescriptor> = Object.create(null)
  const limits: Record<string, Partial<ConnectionLimits> | undefined> = Object.create(null)
  for (const connectionId of agent.definition.connections) {
    let connection: Awaited<ReturnType<typeof config.getConnection>>
    try {
      connection = await config.getConnection(connectionId)
    } catch (err) {
      // Wrong master key or damaged data: retrying cannot help. The message names the connection only.
      if (err instanceof SecretDecryptError) throw new ConfigError(`connection secret could not be decrypted: ${connectionId}`)
      throw err
    }
    if (!connection) throw new ConfigError(`connection not found: ${connectionId}`)
    limits[connectionId] = connection.limits ?? undefined
    for (const tool of connection.tools) {
      if (Object.hasOwn(toolsByName, tool.name)) throw new ConfigError(`duplicate tool name: ${tool.name}`)
      toolsByName[tool.name] = tool
    }
  }
  return { agent: agent.definition, agentVersion: agent.version, toolsByName, guard: new PgConnectionGuard(pool, tenantId, limits) }
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

/** Fails a run whose wait for a human has expired. A human who answered first wins: the append expects the same log head. */
async function expireDueWait(deps: RunWorkerDeps, runId: string, tenantId: string): Promise<void> {
  const store = new PgRunStore(deps.pool, tenantId, { lockedBy: deps.workerId })
  const events = await store.readEvents(runId)
  const expired = expireWait(events, new Date())
  if (expired === null) return
  try {
    await store.append(runId, expired, { expect: { status: 'waiting_human', lastSeq: events.at(-1)!.seq } })
  } catch (err) {
    if (!(err instanceof StateConflictError)) throw err
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
    // A waiting run keeps its job, due when the wait expires (see below).
    try {
      await expireDueWait(deps, runId, tenantId)
    } catch (err) {
      // Transient: the lock expires and the job runs again. Never fail the run for it.
      console.error(`worker: could not check the wait expiry of run ${runId}; the lock will expire`, err)
      return
    }
    let ctx: RunContext
    try {
      ctx = await (deps.loadContext ?? ((r, t) => loadContext(deps.pool, deps.secrets, r, t)))(runId, tenantId)
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
    const store = new PgRunStore(deps.pool, tenantId, { lockedBy: deps.workerId })
    status = await advance(runId, {
      store,
      tenantCostToday: () => store.tenantCostSince(startOfUtcDay(new Date())),
      llm: deps.llm,
      tools: deps.tools(tenantId),
      ...ctx,
      signal: ctl.abort.signal,
      subruns: createSubruns(deps.pool, deps.secrets, tenantId),
      ...(deps.now === undefined ? {} : { now: deps.now }),
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
    // The run waits for an LLM retry or for a connection slot. Put the job back, unlocked, for when it is due: no settle, no release.
    try {
      const events = await new PgRunStore(deps.pool, tenantId, { lockedBy: deps.workerId }).readEvents(runId)
      const proj = projectRun(events, '')
      if (proj.status === 'running') {
        const now = Date.now()
        const due = proj.deferral?.retryAt ?? proj.llmRetry.retryAt
        const retryAt = due === null ? Number.NaN : new Date(due).getTime()
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
    await deps.onRunSettled?.(runId, tenantId, status)
  } catch (err) {
    console.error(`worker: onRunSettled failed for run ${runId}; the job will be retried`, err)
    return
  }
  if (TERMINAL.includes(status)) {
    // A child run that ended wakes its parent workflow now instead of at the parent's next check.
    try {
      const first = (await new PgRunStore(deps.pool, tenantId).readEvents(runId))[0]
      if (first?.type === 'run.created' && first.payload.parent !== undefined) await makeDue(deps.pool, tenantId, first.payload.parent.runId)
    } catch (err) {
      console.error(`worker: could not wake the parent of run ${runId}; it wakes at its next check`, err)
    }
  }
  if (status === 'waiting_human' || status === 'sleeping') {
    // Keep the job, due when the wait expires or the run wakes up. A human's answer makes it due at once
    // (the input route enqueues); a job claimed before the wake time sleeps on and comes back here.
    try {
      const proj = projectRun(await new PgRunStore(deps.pool, tenantId).readEvents(runId), '')
      const due =
        proj.status === 'waiting_human'
          ? proj.waitExpiresAt
          : proj.status === 'sleeping'
            ? (proj.wakeAt ?? new Date(Date.now() + SUBRUN_POLL_MS).toISOString())
            : null
      if (due !== null) {
        // Same guard as the retry path: when the worker clock lags the database, the job must not spin.
        const dueAt = Math.max(new Date(due).getTime(), Date.now() + MIN_REQUEUE_DELAY_MS)
        await requeueIfHolder(deps.pool, runId, deps.workerId, new Date(dueAt))
        return
      }
    } catch (err) {
      console.error(`worker: could not keep the due time of run ${runId}; the lock will expire`, err)
      return
    }
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
