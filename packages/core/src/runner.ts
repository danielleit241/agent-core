import type { LLMPort, RunStore, ToolInvoker } from './ports'
import { projectRun, type RunProjection } from './projection'
import { decide } from './rules'
import type { AgentDefinition, NewEvent, RunStatus, ToolCall, ToolDescriptor, WaitingReason } from './types'

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
}

const DEFAULT_MAX_LLM_CALLS = 30

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
    // The worker died after `tool.requested`. Reads are retried with the same key; writes are never repeated.
    if (tool === undefined || tool.safety.effect !== 'read') {
      await append(waitHuman('running', 'unknown_outcome'))
      return 'waiting_human'
    }
    return execute(runId, deps, call, tool, false)
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
  if (decision === undefined) {
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
  if (decision === 'require_approval' && !proj.approvals.has(call.id)) {
    // Also the crash-safe path: the decision was logged but the approval request was not.
    const events: NewEvent[] = []
    if (!proj.awaitingApproval.includes(call.id)) {
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
  return execute(runId, deps, call, tool, true)
}

async function execute(
  runId: string,
  deps: RunnerDeps,
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
  let result: Awaited<ReturnType<ToolInvoker['call']>>
  try {
    result = await deps.tools.call(tool, call.arguments, { idempotencyKey, dryRun: false })
  } catch (err) {
    if (isNotSent(err) || tool.safety.effect === 'read') {
      await deps.store.append(runId, [toolError(call.id, toolUnavailable(err))])
      return 'continue'
    }
    await deps.store.append(runId, [waitHuman('running', 'unknown_outcome')])
    return 'waiting_human'
  }
  await deps.store.append(runId, [
    {
      type: 'tool.responded',
      payload: { toolCallId: call.id, content: result.content, isError: result.isError },
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
    res = await deps.llm.complete({
      model: deps.agent.model,
      messages: proj.messages,
      tools: Object.values(deps.toolsByName),
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
