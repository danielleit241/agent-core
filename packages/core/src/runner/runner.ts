import { AppendConflictError, type ConnectionGuard, type ContentStore, type LLMPort, type RunStore, type SubrunPort, type ToolInvoker } from '../ports'
import { projectRun, type RunProjection } from '../events/projection'
import { snapshotRequest } from '../content/snapshot'
import { createSecretMatcher } from '../content/secrets'
import { screenedToolResponse } from '../content/pipeline'
import { decide } from '../policy/rules'
import { resolveLimits, type LimitName, type Limits } from '../limits'
import { repeatedCalls, stalledTurns } from './loops'
import { FOLLOWUP_TOOL, MAX_FOLLOWUPS, builtinTools, isBuiltin, parseFollowup, parseHumanWait } from './builtins'
import type { AgentDefinition, Message, NewEvent, RunStatus, StoredEvent, ToolCall, ToolDescriptor, WaitingReason } from '../types'

export type RunnerDeps = {
  store: RunStore
  llm: LLMPort
  tools: ToolInvoker
  /** Holds a snapshot of every LLM request, by content hash. */
  content: ContentStore
  /** Exact secrets the service holds (connection secrets, the LLM key). They are removed from every tool output. */
  secretValues?: string[]
  /** Called with the kind → count of secrets removed from a tool output (not called when none). */
  onRedacted?: (redactions: Record<string, number>) => void
  /** Rate, concurrency and breaker of each connection. Without one, calls are not limited. */
  guard?: ConnectionGuard
  /** Child runs of workflow `subrun` steps. */
  subruns?: SubrunPort
  agent: AgentDefinition
  toolsByName: Record<string, ToolDescriptor>
  agentVersion: number
  /** The tenant's LLM cost since 00:00 UTC today, over all its runs. */
  tenantCostToday: () => Promise<number>
  /** When aborted, `advanceRun` stops before its next step and appends nothing more. */
  signal?: AbortSignal
  /** Clock for the current-time context item. Tests inject a fixed one. */
  now?: () => Date
  /** Jitter source for retry waits. Tests inject a fixed one. */
  random?: () => number
  /** Waits between tool attempts. Tests inject one that resolves at once. */
  sleep?: (ms: number) => Promise<void>
}

const TOOL_MAX_ATTEMPTS = 3
const TOOL_RETRY_WAITS_MS = [500, 1000]
const LLM_RETRY_WAITS_MS = [30_000, 60_000, 120_000, 240_000, 300_000]
const LLM_MAX_WAIT_MS = 300_000
// Short: nothing tells a waiter when a slot frees, so a long wait leaves slots idle.
const CONCURRENCY_MAX_WAIT_S = 10
// A call that waits on its connection this long gets a tool error, so the agent can handle it.
const DEFERRAL_MAX_MS = 3_600_000

const jitter = (ms: number, random: () => number): number => Math.round(ms * (0.8 + 0.4 * random()))
const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const isRetryable = (tool: ToolDescriptor): boolean =>
  tool.safety.effect === 'read' || (tool.safety.effect === 'write' && tool.safety.idempotency === true)

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff

/** Keeps the head and the tail of a long output, so both a header and a final summary survive. */
function capToolOutput(content: string, max: number): string {
  if (content.length <= max) return content
  let head = Math.floor(max / 2)
  let tail = content.length - Math.floor(max / 2)
  // Never split a surrogate pair: Postgres refuses a lone surrogate in jsonb.
  if (isHighSurrogate(content.charCodeAt(head - 1))) head -= 1
  if (isHighSurrogate(content.charCodeAt(tail - 1))) tail += 1
  return `${content.slice(0, head)}
[... ${tail - head} characters cut ...]
${content.slice(tail)}`
}

// Shared with the workflow runner (./workflow.ts) from here to `handleToolCall`.
export const stateChanged = (from: RunStatus, to: RunStatus, reason?: string): NewEvent => ({
  type: 'run.state_changed',
  payload: reason === undefined ? { from, to } : { from, to, reason },
  labels: [],
})

const toolError = (toolCallId: string, content: string): NewEvent => ({
  type: 'tool.responded',
  payload: { toolCallId, content, isError: true },
  labels: [],
})

export const waitHuman = (from: RunStatus, reason: WaitingReason, expiresAt: string, extra: Record<string, string> = {}): NewEvent => ({
  type: 'run.state_changed',
  payload: { from, to: 'waiting_human', reason, expiresAt, ...extra },
  labels: [],
})

type Breach = { limit: LimitName; max: number; value: number }
export const limitReached = (b: Breach): NewEvent => ({ type: 'limit.reached', payload: b, labels: [] })

export const nowOf = (deps: RunnerDeps): Date => (deps.now ?? (() => new Date()))()
const limitsOf = (deps: RunnerDeps): Limits => resolveLimits(deps.agent.limits)
/** When a wait for a human that starts now expires. */
export const expiresAt = (deps: RunnerDeps): string => new Date(nowOf(deps).getTime() + limitsOf(deps).wait_human_s * 1000).toISOString()

/** One grant from a human gives one more full allowance. */
function breach(proj: RunProjection, limits: Limits, limit: LimitName, value: number): Breach | null {
  const max = limits[limit] * (1 + proj.limitGrants[limit])
  return value >= max ? { limit, max, value } : null
}

/**
 * Checks the run limits before a step: before a tool call when `call` is set, else before an LLM step.
 * The tenant cost is read only before an LLM step.
 */
export async function checkRunLimits(deps: RunnerDeps, proj: RunProjection, call: ToolCall | undefined): Promise<Breach | null> {
  const limits = limitsOf(deps)
  const now = nowOf(deps).getTime()
  const runningMs = proj.runningMs + (proj.runningSince === null ? 0 : now - Date.parse(proj.runningSince))
  const time = breach(proj, limits, 'run_time_s', Math.floor(runningMs / 1000))
  if (time !== null) return time
  if (call !== undefined) return breach(proj, limits, 'loop', repeatedCalls(proj.messages, call))
  return (
    breach(proj, limits, 'llm_calls', proj.llmCalls) ??
    breach(proj, limits, 'tokens', proj.tokens) ??
    breach(proj, limits, 'cost_usd', proj.costUsd) ??
    breach(proj, limits, 'tenant_cost_usd_per_day', await deps.tenantCostToday()) ??
    breach(proj, limits, 'loop', stalledTurns(proj.messages))
  )
}

/**
 * Fails a run whose wait for a human has expired. Returns the events to append, or null when the run
 * does not wait, waits without `expiresAt` (an old log), or has time left.
 */
export function expireWait(events: StoredEvent[], now: Date): NewEvent[] | null {
  const proj = projectRun(events, '')
  if (proj.status !== 'waiting_human' || proj.waitExpiresAt === null || proj.waitStartedAt === null) return null
  if (now.getTime() < Date.parse(proj.waitExpiresAt)) return null
  const started = Date.parse(proj.waitStartedAt)
  return [
    limitReached({
      limit: 'wait_human_s',
      max: Math.round((Date.parse(proj.waitExpiresAt) - started) / 1000),
      value: Math.floor((now.getTime() - started) / 1000),
    }),
    stateChanged('waiting_human', 'failed', 'wait_expired'),
  ]
}

const isNotSent = (err: unknown): boolean => (err as { notSent?: unknown } | null)?.notSent === true
export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))
// Fixed text: an adapter error message may carry secrets (for example a URL) and must not reach events or the LLM.
const toolUnavailable = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? `Tool unavailable (${code}).` : 'Tool unavailable.'
}
// An adapter may add a short `detail` (for example "HTTP 503"); anything that could hold a URL or a secret is dropped.
const SAFE_DETAIL = /^[A-Za-z0-9 ._-]{1,40}$/
const failedAfterSend = (err: unknown): string => {
  const { code, detail } = (err ?? {}) as { code?: unknown; detail?: unknown }
  const c = typeof code === 'string' && SAFE_DETAIL.test(code) ? code : 'tool_call_failed'
  const d = typeof detail === 'string' && SAFE_DETAIL.test(detail) ? `: ${detail}` : ''
  return `The tool call failed after it was sent (${c}${d}). It may have run.`
}
/** The evidence of why a run waits on an unknown outcome. The text is fixed, so it is safe for events. */
const unknownOutcome = (why: string, expires: string): NewEvent[] => [
  { type: 'error.raised', payload: { message: why, retryable: false }, labels: [] },
  waitHuman('running', 'unknown_outcome', expires),
]

/**
 * Advances a run until it completes, fails, or needs a human. State is recomputed from
 * the event log before every step and each step is appended on its own, so a crash loses
 * at most the step in progress and calling `advanceRun` again resumes the run.
 */
export async function advanceRun(runId: string, deps: RunnerDeps): Promise<RunStatus> {
  const builtins = builtinTools(deps.agent)
  if (builtins.length > 0) {
    // No prototype, as in the worker: a tool name must not collide with inherited members.
    const toolsByName: Record<string, ToolDescriptor> = Object.assign(Object.create(null), deps.toolsByName)
    for (const t of builtins) toolsByName[t.name] = t
    deps = { ...deps, toolsByName }
  }
  for (;;) {
    const proj = projectRun(await deps.store.readEvents(runId), deps.agent.instructions)
    if (deps.signal?.aborted) return proj.status
    if (proj.status === 'queued') {
      await deps.store.append(runId, [stateChanged('queued', 'running')])
      continue
    }
    if (proj.status === 'sleeping') {
      // Woken early (for example by a message): sleep on. The worker puts the job back for `wakeAt`.
      if (proj.wakeAt !== null && nowOf(deps).getTime() < Date.parse(proj.wakeAt)) return 'sleeping'
      await deps.store.append(runId, [...wakeUp(deps, proj), stateChanged('sleeping', 'running')])
      continue
    }
    if (proj.status !== 'running') return proj.status
    if (proj.cancelRequested) {
      await deps.store.append(runId, [stateChanged('running', 'cancelled', 'cancelled')])
      return 'cancelled'
    }

    const call = proj.pendingToolCalls[0]
    // A call in flight finishes first: stopping there would leave its outcome unknown.
    if (call === undefined || !proj.inFlight.includes(call.id)) {
      const b = await checkRunLimits(deps, proj, call)
      if (b !== null) {
        await deps.store.append(runId, [limitReached(b), waitHuman('running', 'limit', expiresAt(deps))])
        return 'waiting_human'
      }
    }
    const outcome = call !== undefined ? await handleToolCall(runId, deps, proj, call) : await llmStep(runId, deps, proj)
    if (outcome !== 'continue') return outcome
  }
}

export async function handleToolCall(
  runId: string,
  deps: RunnerDeps,
  proj: RunProjection,
  call: ToolCall,
): Promise<RunStatus | 'continue'> {
  const { store } = deps
  const append = (...events: NewEvent[]) => store.append(runId, events)
  const tool = Object.hasOwn(deps.toolsByName, call.name) ? deps.toolsByName[call.name] : undefined
  const inFlight = proj.inFlight.includes(call.id)

  if (inFlight) {
    // The worker died after `tool.requested`. Reads and keyed writes are called again with the same key; other writes are never repeated.
    const changed = tool !== undefined && isRetryable(tool) && tool.safety.effect === 'write' && tool.changedSinceReview === true
    if (tool === undefined || !isRetryable(tool) || changed) {
      const why =
        tool === undefined
          ? 'The run stopped after the tool call was sent, and the tool is no longer known. It may have run.'
          : changed
            ? 'The run stopped after the tool call was sent, and the tool changed since review. It may have run.'
            : 'The run stopped after the tool call was sent. It may have run.'
      await append(...unknownOutcome(why, expiresAt(deps)))
      return 'waiting_human'
    }
    if (isBuiltin(tool.name)) return runBuiltin(runId, deps, proj, call, false)
    return execute(runId, deps, proj, call, tool, false)
  }
  if (call.argumentsError !== undefined) {
    await append(toolError(call.id, `Invalid arguments: ${call.argumentsError}. Send valid JSON matching the schema.`))
    return 'continue'
  }
  if (tool === undefined) {
    await append(toolError(call.id, `Unknown tool: ${call.name}`))
    return 'continue'
  }
  if (proj.approvals.get(call.id) === 'reject') {
    await append(toolError(call.id, 'A human rejected this action. Do not retry it; tell the user.'))
    return 'continue'
  }

  let decision = proj.ruleDecisions.get(call.id)
  let reason = proj.ruleReasons.get(call.id) ?? ''
  // A decision or approval made before the tool changed does not cover the changed tool.
  const stale = tool.changedSinceReview === true && reason !== 'tool_changed_since_review'
  if (decision === undefined || stale) {
    const d = decide({ tool, args: call.arguments, agent: deps.agent })
    decision = d.decision
    reason = d.reason
    await append({
      type: 'rule.decided',
      payload: { toolCallId: call.id, tool: call.name, decision, reason },
      labels: [],
    })
  }
  if (decision === 'deny') {
    await append(toolError(call.id, `This action is not allowed: ${reason}`))
    return 'continue'
  }
  if (decision === 'require_approval' && (stale || !proj.approvals.has(call.id))) {
    // Also the crash-safe path: the decision was logged but the approval request was not.
    const events: NewEvent[] = []
    if (stale || !proj.awaitingApproval.includes(call.id)) {
      events.push({
        type: 'approval.requested',
        payload: { toolCallId: call.id, tool: call.name, args: call.arguments, reason },
        labels: [],
      })
    }
    events.push(waitHuman('running', 'approval', expiresAt(deps)))
    await append(...events)
    return 'waiting_human'
  }
  if (isBuiltin(tool.name)) return runBuiltin(runId, deps, proj, call, true)
  return execute(runId, deps, proj, call, tool, true)
}

/** Built-in tools do not go through the tool invoker; each one changes the run state itself. */
function runBuiltin(runId: string, deps: RunnerDeps, proj: RunProjection, call: ToolCall, recordRequest: boolean): Promise<RunStatus | 'continue'> {
  return call.name === FOLLOWUP_TOOL ? scheduleFollowup(runId, deps, proj, call, recordRequest) : waitForHuman(runId, deps, call, recordRequest)
}

const requested = (runId: string, call: ToolCall): NewEvent => ({
  type: 'tool.requested',
  payload: { toolCallId: call.id, tool: call.name, args: call.arguments, idempotencyKey: `${runId}:${call.id}` },
  labels: [],
})

/** `ask_human` and `escalate`: the call stays open until a human answers; see the `answer` input action. */
async function waitForHuman(runId: string, deps: RunnerDeps, call: ToolCall, recordRequest: boolean): Promise<RunStatus | 'continue'> {
  const wait = parseHumanWait(call.name, call.arguments)
  if (wait === null) {
    await deps.store.append(runId, [toolError(call.id, 'Invalid arguments: send one non-empty string of at most 2000 characters, as the schema says.')])
    return 'continue'
  }
  await deps.store.append(runId, [...(recordRequest ? [requested(runId, call)] : []), waitHuman('running', wait.reason, expiresAt(deps), wait.extra)])
  return 'waiting_human'
}

/** Puts the run to sleep. The call stays open until the run wakes up; see `wakeUp`. */
async function scheduleFollowup(
  runId: string,
  deps: RunnerDeps,
  proj: RunProjection,
  call: ToolCall,
  recordRequest: boolean,
): Promise<RunStatus | 'continue'> {
  const args = parseFollowup(call.arguments)
  if (!args.success) {
    await deps.store.append(runId, [
      toolError(call.id, 'Invalid arguments: after_seconds must be an integer from 60 to 2592000, and note a string of at most 1000 characters.'),
    ])
    return 'continue'
  }
  if (proj.followups >= MAX_FOLLOWUPS) {
    await deps.store.append(runId, [toolError(call.id, `Follow-up limit reached: a run may schedule at most ${MAX_FOLLOWUPS} follow-ups.`)])
    return 'continue'
  }
  const wakeAt = new Date(nowOf(deps).getTime() + args.data.after_seconds * 1000).toISOString()
  await deps.store.append(runId, [
    ...(recordRequest ? [requested(runId, call)] : []),
    { type: 'run.state_changed', payload: { from: 'running', to: 'sleeping', wakeAt }, labels: [] },
  ])
  return 'sleeping'
}

/** The result of the follow-up call that put the run to sleep. */
function wakeUp(deps: RunnerDeps, proj: RunProjection): NewEvent[] {
  const call = proj.pendingToolCalls.find((c) => c.name === FOLLOWUP_TOOL && proj.inFlight.includes(c.id))
  if (call === undefined) return []
  const note = typeof call.arguments.note === 'string' ? call.arguments.note : ''
  return [
    {
      type: 'tool.responded',
      payload: { toolCallId: call.id, content: `Follow-up at ${proj.wakeAt ?? nowOf(deps).toISOString()}. Note: ${note}`, isError: false },
      labels: ['untrusted'],
    },
  ]
}

type Gate = { lease?: string } | { stop: RunStatus | 'continue' }

/**
 * Asks the connection guard for a slot before a call is sent. When the guard says no, the call is deferred
 * with a `retryAt` and the run waits: it neither fails nor waits for a human.
 */
async function passGuard(runId: string, deps: RunnerDeps, proj: RunProjection, call: ToolCall, tool: ToolDescriptor): Promise<Gate> {
  if (deps.guard === undefined) return {}
  const now = nowOf(deps).getTime()
  const deferral = proj.deferral?.toolCallId === call.id ? proj.deferral : null
  // Woken before `retryAt`, for example by input: wait on.
  if (deferral !== null && now < Date.parse(deferral.retryAt)) return { stop: 'running' }
  let res: Awaited<ReturnType<ConnectionGuard['acquire']>>
  try {
    res = await deps.guard.acquire(tool.connectionId)
  } catch {
    // The guard's own store failed, not the connection: the worker tries again soon. Nothing was sent.
    return { stop: 'running' }
  }
  if ('lease' in res) return { lease: res.lease }
  if (deferral !== null && now - Date.parse(deferral.since) >= DEFERRAL_MAX_MS) {
    // A write sent before (a retry, or a resume after a crash) may have run: a human must say.
    if (proj.inFlight.includes(call.id) && tool.safety.effect !== 'read') {
      await deps.store.append(runId, unknownOutcome('The tool call was sent, then its connection stayed unavailable for an hour. It may have run.', expiresAt(deps)))
      return { stop: 'waiting_human' }
    }
    await deps.store.append(runId, [toolError(call.id, 'Connection unavailable.')])
    return { stop: 'continue' }
  }
  // Concurrency has no known free time: back off 1, 2, 4 ... s, so a busy connection does not flood the log.
  const backoffS = Math.min(2 ** (deferral?.count ?? 0), CONCURRENCY_MAX_WAIT_S)
  const retryAt = res.denied.retryAt ?? new Date(now + backoffS * 1000).toISOString()
  await deps.store.append(runId, [
    { type: 'tool.deferred', payload: { toolCallId: call.id, reason: res.denied.reason, retryAt }, labels: [] },
  ])
  return { stop: 'running' }
}

/** Gives the slot back. A failed release only delays the slot: the lease expires on its own. */
async function releaseGate(deps: RunnerDeps, gate: Gate, outcome: 'ok' | 'failed' | 'unused'): Promise<void> {
  if (!('lease' in gate) || gate.lease === undefined) return
  await deps.guard?.release(gate.lease, outcome).catch(() => undefined)
}

async function execute(
  runId: string,
  deps: RunnerDeps,
  proj: RunProjection,
  call: ToolCall,
  tool: ToolDescriptor,
  recordRequest: boolean,
): Promise<RunStatus | 'continue'> {
  const idempotencyKey = `${runId}:${call.id}`
  let gate = await passGuard(runId, deps, proj, call, tool)
  if ('stop' in gate) return gate.stop
  if (recordRequest) {
    try {
      await deps.store.append(runId, [
        {
          type: 'tool.requested',
          payload: { toolCallId: call.id, tool: call.name, args: call.arguments, idempotencyKey },
          labels: [],
        },
      ])
    } catch (err) {
      await releaseGate(deps, gate, 'unused')
      throw err
    }
  }
  const retryable = isRetryable(tool)
  const maxAttempts = retryable ? TOOL_MAX_ATTEMPTS : 1
  const random = deps.random ?? Math.random
  const sleep = deps.sleep ?? sleepMs
  // On a resume an earlier attempt may have landed, so the call counts as sent.
  let sent = !recordRequest
  let result: Awaited<ReturnType<ToolInvoker['call']>> | undefined
  for (let attempt = 1; result === undefined; attempt++) {
    if (attempt > 1) {
      await sleep(jitter(TOOL_RETRY_WAITS_MS[attempt - 2]!, random))
      if (deps.signal?.aborted) return proj.status
      gate = await passGuard(runId, deps, proj, call, tool)
      if ('stop' in gate) return gate.stop
    }
    try {
      result = await deps.tools.call(tool, call.arguments, {
        idempotencyKey,
        dryRun: false,
        ...(proj.principal === null ? {} : { principal: proj.principal }),
      })
      // A tool result with `isError` is a working connection.
      await releaseGate(deps, gate, 'ok')
    } catch (err) {
      await releaseGate(deps, gate, 'failed')
      if (!isNotSent(err)) sent = true
      if (retryable) {
        await deps.store.append(runId, [
          {
            type: 'error.raised',
            payload: { message: isNotSent(err) ? toolUnavailable(err) : failedAfterSend(err), retryable: attempt < maxAttempts },
            labels: [],
          },
        ])
      }
      if (attempt >= maxAttempts) {
        if (tool.safety.effect === 'read' || !sent) {
          await deps.store.append(runId, [toolError(call.id, toolUnavailable(err))])
          return 'continue'
        }
        await deps.store.append(runId, unknownOutcome(failedAfterSend(err), expiresAt(deps)))
        return 'waiting_human'
      }
    }
  }
  const screened = await screenedToolResponse({ toolCallId: call.id }, result, [tool.safety.outputLabel], {
    secrets: createSecretMatcher(deps.secretValues ?? []),
  })
  if (screened.payload.redactions !== undefined) deps.onRedacted?.(screened.payload.redactions)
  const maxChars = limitsOf(deps).tool_output_chars
  const length = screened.payload.content.length
  // The cut keeps the run safe, so a long output is recorded but does not stop the run.
  const tooLong = length > maxChars ? [limitReached({ limit: 'tool_output_chars', max: maxChars, value: length })] : []
  await deps.store.append(runId, [
    ...tooLong,
    { ...screened, payload: { ...screened.payload, content: capToolOutput(screened.payload.content, maxChars) } },
  ])
  return 'continue'
}

/** When to try a failed LLM call again, or null when the error is final or the retries are used up. */
export function llmRetryAt(err: unknown, proj: RunProjection, deps: RunnerDeps): string | null {
  const { retryable, retryAfterMs } = (err ?? {}) as { retryable?: unknown; retryAfterMs?: unknown }
  const attempts = proj.llmRetry.attempts
  if (retryable !== true || attempts >= LLM_RETRY_WAITS_MS.length) return null
  // The provider's hint can only lengthen the computed wait.
  const hint = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : 0
  const wait = Math.max(hint, jitter(LLM_RETRY_WAITS_MS[attempts]!, deps.random ?? Math.random))
  return new Date(nowOf(deps).getTime() + Math.min(wait, LLM_MAX_WAIT_MS)).toISOString()
}

async function llmStep(
  runId: string,
  deps: RunnerDeps,
  proj: RunProjection,
): Promise<RunStatus | 'continue'> {
  const { store } = deps
  const now = deps.now ?? (() => new Date())
  // The run waits for an LLM retry; the worker calls again once `retryAt` has passed.
  if (proj.llmRetry.retryAt !== null && new Date(proj.llmRetry.retryAt).getTime() > now().getTime()) return 'running'
  // The time goes into the request only. It is not an event, so the projection never holds it.
  const firstTurn = proj.messages.findIndex((m) => m.role !== 'system')
  const at = firstTurn === -1 ? proj.messages.length : firstTurn
  const requestedAt = now()
  const messages: Message[] = [
    ...proj.messages.slice(0, at),
    { role: 'system', content: `Current time: ${requestedAt.toISOString()}`, volatile: true },
    ...proj.messages.slice(at),
  ]
  // A tool changed since review stays hidden until an owner reviews it again.
  const tools = Object.values(deps.toolsByName).filter((t) => t.changedSinceReview !== true)
  // Stored before the event: a crash in between leaves only blobs, and the next step stores them again as no-ops.
  const context = await snapshotRequest(deps.content, { messages, tools })
  await store.append(runId, [{ type: 'llm.requested', payload: { model: deps.agent.model, context }, labels: [] }])
  let res: Awaited<ReturnType<LLMPort['complete']>>
  try {
    res = await deps.llm.complete({
      model: deps.agent.model,
      messages,
      tools,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    })
  } catch (err) {
    // The worker stopped the call. The open `llm.requested` is the same state as a crash mid-call; resume handles it.
    if (deps.signal?.aborted) return 'running'
    const retryAt = llmRetryAt(err, proj, deps)
    if (retryAt !== null) {
      await store.append(runId, [
        { type: 'error.raised', payload: { message: errorMessage(err), retryable: true, retryAt }, labels: [] },
      ])
      return 'running'
    }
    await store.append(runId, [
      { type: 'error.raised', payload: { message: errorMessage(err), retryable: false }, labels: [] },
      stateChanged('running', 'failed'),
    ])
    return 'failed'
  }
  const responded: NewEvent = {
    type: 'llm.responded',
    payload: { message: res.message, usage: res.usage, stopReason: res.stopReason },
    labels: [],
  }
  const seen = new Set(proj.messages.flatMap((m) => m.toolCalls?.map((c) => c.id) ?? []))
  for (const c of res.message.toolCalls ?? []) {
    if (seen.has(c.id)) {
      await store.append(runId, [
        { type: 'error.raised', payload: { message: `provider reused tool call id ${c.id}`, retryable: false }, labels: [] },
        stateChanged('running', 'failed'),
      ])
      return 'failed'
    }
    seen.add(c.id)
  }
  const hasToolCalls = (res.message.toolCalls?.length ?? 0) > 0
  if (res.stopReason === 'filtered') {
    await store.append(runId, [
      responded,
      { type: 'error.raised', payload: { message: 'LLM response filtered by the provider', retryable: false }, labels: [] },
      stateChanged('running', 'failed', 'filtered'),
    ])
    return 'failed'
  }
  if (res.stopReason === 'end') {
    try {
      // Written only if nothing arrived during the call: a message sent meanwhile must still be read.
      await store.append(runId, [responded, stateChanged('running', 'completed')], { expect: { lastSeq: proj.lastSeq + 1 } })
      return 'completed'
    } catch (err) {
      if (!(err instanceof AppendConflictError)) throw err
      // Input arrived. Keep the answer; the next step reads the input (a message or a cancel).
      await store.append(runId, [responded])
      return 'continue'
    }
  }
  if (res.stopReason === 'length' && !hasToolCalls) {
    await store.append(runId, [
      responded,
      { type: 'error.raised', payload: { message: 'LLM output truncated (length)', retryable: false }, labels: [] },
      stateChanged('running', 'failed'),
    ])
    return 'failed'
  }
  await store.append(runId, [responded])
  return 'continue'
}
