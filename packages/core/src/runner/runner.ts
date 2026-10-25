import type { LLMPort, RunStore, ToolInvoker } from '../ports'
import { projectRun, type RunProjection } from '../events/projection'
import { decide } from '../policy/rules'
import type { AgentDefinition, NewEvent, RunStatus, ToolCall, ToolDescriptor, WaitingReason } from '../types'

export type RunnerDeps = {
  store: RunStore
  llm: LLMPort
  tools: ToolInvoker
  agent: AgentDefinition
  toolsByName: Record<string, ToolDescriptor>
  agentVersion: number
  maxLlmCalls?: number
  /** When aborted, `advanceRun` stops before its next step and appends nothing more. */
  signal?: AbortSignal
  /** Clock for the current-time context item. Tests inject a fixed one. */
  now?: () => Date
  /** Jitter source for retry waits. Tests inject a fixed one. */
  random?: () => number
  /** Waits between tool attempts. Tests inject one that resolves at once. */
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_MAX_LLM_CALLS = 30
// About 12k tokens: a large tool output would fill the LLM context and every later request.
const MAX_TOOL_OUTPUT_CHARS = 48_000

const TOOL_MAX_ATTEMPTS = 3
const TOOL_RETRY_WAITS_MS = [500, 1000]

const jitter = (ms: number, random: () => number): number => Math.round(ms * (0.8 + 0.4 * random()))
const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const isRetryable = (tool: ToolDescriptor): boolean =>
  tool.safety.effect === 'read' || (tool.safety.effect === 'write' && tool.safety.idempotency === true)

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff

/** Keeps the head and the tail of a long output, so both a header and a final summary survive. */
function capToolOutput(content: string): string {
  if (content.length <= MAX_TOOL_OUTPUT_CHARS) return content
  let head = MAX_TOOL_OUTPUT_CHARS / 2
  let tail = content.length - MAX_TOOL_OUTPUT_CHARS / 2
  // Never split a surrogate pair: Postgres refuses a lone surrogate in jsonb.
  if (isHighSurrogate(content.charCodeAt(head - 1))) head -= 1
  if (isHighSurrogate(content.charCodeAt(tail - 1))) tail += 1
  return `${content.slice(0, head)}
[... ${tail - head} characters cut ...]
${content.slice(tail)}`
}

const stateChanged = (from: RunStatus, to: RunStatus, reason?: string): NewEvent => ({
  type: 'run.state_changed',
  payload: reason === undefined ? { from, to } : { from, to, reason },
  labels: [],
})

const toolError = (toolCallId: string, content: string): NewEvent => ({
  type: 'tool.responded',
  payload: { toolCallId, content, isError: true },
  labels: [],
})

const waitHuman = (from: RunStatus, reason: WaitingReason): NewEvent => stateChanged(from, 'waiting_human', reason)

const isNotSent = (err: unknown): boolean => (err as { notSent?: unknown } | null)?.notSent === true
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))
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
const unknownOutcome = (why: string): NewEvent[] => [
  { type: 'error.raised', payload: { message: why, retryable: false }, labels: [] },
  waitHuman('running', 'unknown_outcome'),
]

/**
 * Advances a run until it completes, fails, or needs a human. State is recomputed from
 * the event log before every step and each step is appended on its own, so a crash loses
 * at most the step in progress and calling `advanceRun` again resumes the run.
 */
export async function advanceRun(runId: string, deps: RunnerDeps): Promise<RunStatus> {
  const maxLlmCalls = deps.maxLlmCalls ?? DEFAULT_MAX_LLM_CALLS
  for (;;) {
    const proj = projectRun(await deps.store.readEvents(runId), deps.agent.instructions)
    if (deps.signal?.aborted) return proj.status
    if (proj.status === 'queued') {
      await deps.store.append(runId, [stateChanged('queued', 'running')])
      continue
    }
    if (proj.status !== 'running') return proj.status

    const call = proj.pendingToolCalls[0]
    const outcome = call !== undefined ? await handleToolCall(runId, deps, proj, call) : await llmStep(runId, deps, proj, maxLlmCalls)
    if (outcome !== 'continue') return outcome
  }
}

async function handleToolCall(
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
    if (tool === undefined || !isRetryable(tool)) {
      const why =
        tool === undefined
          ? 'The run stopped after the tool call was sent, and the tool is no longer known. It may have run.'
          : 'The run stopped after the tool call was sent. It may have run.'
      await append(...unknownOutcome(why))
      return 'waiting_human'
    }
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
    events.push(waitHuman('running', 'approval'))
    await append(...events)
    return 'waiting_human'
  }
  return execute(runId, deps, proj, call, tool, true)
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
  if (recordRequest) {
    await deps.store.append(runId, [
      {
        type: 'tool.requested',
        payload: { toolCallId: call.id, tool: call.name, args: call.arguments, idempotencyKey },
        labels: [],
      },
    ])
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
    }
    try {
      result = await deps.tools.call(tool, call.arguments, {
        idempotencyKey,
        dryRun: false,
        ...(proj.principal === null ? {} : { principal: proj.principal }),
      })
    } catch (err) {
      if (!isNotSent(err)) sent = true
      if (retryable) {
        await deps.store.append(runId, [
          {
            type: 'error.raised',
            payload: { message: isNotSent(err) ? toolUnavailable(err) : failedAfterSend(err), retryable: true },
            labels: [],
          },
        ])
      }
      if (attempt >= maxAttempts) {
        if (tool.safety.effect === 'read' || !sent) {
          await deps.store.append(runId, [toolError(call.id, toolUnavailable(err))])
          return 'continue'
        }
        await deps.store.append(runId, unknownOutcome(failedAfterSend(err)))
        return 'waiting_human'
      }
    }
  }
  await deps.store.append(runId, [
    {
      type: 'tool.responded',
      payload: { toolCallId: call.id, content: capToolOutput(result.content), isError: result.isError },
      labels: [tool.safety.outputLabel],
    },
  ])
  return 'continue'
}

async function llmStep(
  runId: string,
  deps: RunnerDeps,
  proj: RunProjection,
  maxLlmCalls: number,
): Promise<RunStatus | 'continue'> {
  const { store } = deps
  if (proj.llmCalls >= maxLlmCalls) {
    await store.append(runId, [waitHuman('running', 'breaker')])
    return 'waiting_human'
  }
  await store.append(runId, [{ type: 'llm.requested', payload: { model: deps.agent.model }, labels: [] }])
  let res: Awaited<ReturnType<LLMPort['complete']>>
  try {
    // The time goes into the request only. It is not an event, so the projection never holds it.
    const firstTurn = proj.messages.findIndex((m) => m.role !== 'system')
    const at = firstTurn === -1 ? proj.messages.length : firstTurn
    const now = (deps.now ?? (() => new Date()))()
    res = await deps.llm.complete({
      model: deps.agent.model,
      messages: [
        ...proj.messages.slice(0, at),
        { role: 'system', content: `Current time: ${now.toISOString()}`, volatile: true },
        ...proj.messages.slice(at),
      ],
      // A tool changed since review stays hidden until an owner reviews it again.
      tools: Object.values(deps.toolsByName).filter((t) => t.changedSinceReview !== true),
    })
  } catch (err) {
    await store.append(runId, [
      {
        type: 'error.raised',
        payload: { message: errorMessage(err), retryable: (err as { retryable?: unknown } | null)?.retryable === true },
        labels: [],
      },
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
  if (res.stopReason === 'end') {
    await store.append(runId, [responded, stateChanged('running', 'completed')])
    return 'completed'
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
