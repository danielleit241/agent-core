import { LIMIT_NAMES, type LimitName } from '../limits'
import type { EventPayloads, Label, Message, RunStatus, StoredEvent, ToolCall, WaitingReason } from '../types'

/** Stands in `RunProjection.sentTools` for a workflow `subrun` step: the child run may write anywhere. */
export const SUBRUN_STARTED = 'workflow.subrun'

/** A tool call that was sent and answered: what the read cache looks up. */
export type CompletedCall = {
  toolCallId: string
  tool: string
  args: Record<string, unknown>
  respondedAt: string
  payload: EventPayloads['tool.responded']
  labels: Label[]
  /** How many calls had been sent (`RunProjection.sentTools`) when it was requested, itself included. */
  sentBefore: number
}

export type RunProjection = {
  status: RunStatus
  waitingReason: WaitingReason | null
  messages: Message[]
  pendingToolCalls: ToolCall[]
  approvals: Map<string, 'approve' | 'reject'>
  awaitingApproval: string[]
  inFlight: string[]
  ruleDecisions: Map<string, 'allow' | 'require_approval' | 'deny'>
  ruleReasons: Map<string, string>
  llmCalls: number
  output: string | null
  principal: { id: string; roles: string[] } | null
  /** LLM retry waits (`error.raised` with `retryAt`) since the last `llm.responded`. */
  llmRetry: { attempts: number; retryAt: string | null }
  /** Input plus output tokens over all LLM responses. */
  tokens: number
  /** Sum of `usage.costUsd`; a response without a cost adds 0. */
  costUsd: number
  /** How many times a human let the run go past each limit. */
  limitGrants: Record<LimitName, number>
  /** Time spent in `running`, closed intervals only. */
  runningMs: number
  /** Start of the open `running` interval, or null. */
  runningSince: string | null
  waitStartedAt: string | null
  waitExpiresAt: string | null
  /** When a sleeping run wakes up, or null. */
  wakeAt: string | null
  /** Follow-ups the run scheduled: each one put it to sleep. */
  followups: number
  /** A human asked to cancel the run while it was running. */
  cancelRequested: boolean
  /** Messages from a human that arrived after the last LLM request. */
  unreadMessages: number
  /** The guard deferrals in a row of the pending call, until it is requested or answered. */
  deferral: { toolCallId: string; count: number; since: string; retryAt: string } | null
  /** Calls that were sent and answered, oldest first. A call served from the cache is not in it. */
  completedCalls: CompletedCall[]
  /** Tool name of every `tool.requested`, in order: the calls that were sent. A started `subrun` step adds `SUBRUN_STARTED`. */
  sentTools: string[]
  /** Seq of the last event. */
  lastSeq: number
}

/** Recomputes the whole run state from its event log. The log is the only source of truth. */
export function projectRun(events: StoredEvent[], instructions: string): RunProjection {
  const first = events[0]
  if (first === undefined || first.type !== 'run.created') throw new Error('run has no run.created event')

  let status: RunStatus = 'queued'
  let waitingReason: WaitingReason | null = null
  const principal = first.payload.principal
  const messages: Message[] = [
    { role: 'system', content: instructions },
    ...(principal === undefined
      ? []
      : // JSON keeps a caller-supplied id from adding lines to the system context.
        [{ role: 'system' as const, content: `Requester: ${JSON.stringify({ id: principal.id, roles: principal.roles })}` }]),
    { role: 'user', content: first.payload.input.text },
  ]
  let lastToolCalls: ToolCall[] = []
  let output: string | null = null
  let llmCalls = 0
  let llmRetry: RunProjection['llmRetry'] = { attempts: 0, retryAt: null }
  const responded = new Set<string>()
  const requested = new Set<string>()
  const sent = new Map<string, { tool: string; args: Record<string, unknown>; sentBefore: number }>()
  const settled = new Set<string>()
  const sentTools: string[] = []
  const completedCalls: CompletedCall[] = []
  const approvalRequested = new Set<string>()
  const approvals: RunProjection['approvals'] = new Map()
  const ruleDecisions: RunProjection['ruleDecisions'] = new Map()
  const ruleReasons: RunProjection['ruleReasons'] = new Map()
  let tokens = 0
  let costUsd = 0
  const limitGrants = Object.fromEntries(LIMIT_NAMES.map((n) => [n, 0])) as Record<LimitName, number>
  let runningMs = 0
  let runningSince: string | null = null
  let waitStartedAt: string | null = null
  let waitExpiresAt: string | null = null
  let wakeAt: string | null = null
  let followups = 0
  let cancelRequested = false
  let deferral: RunProjection['deferral'] = null
  // A deferred call waits on its connection, not on the run: that time is not run time.
  let paused = false
  let unreadMessages = 0
  // A user message between an LLM request and its answer, or between a tool call and its result,
  // breaks the provider's turn order, so it waits until the turn closes.
  let held: Message[] = []
  let llmOpen = false
  const callsOpen = () => lastToolCalls.some((c) => !responded.has(c.id))
  const flush = () => {
    if (llmOpen || callsOpen()) return
    messages.push(...held)
    held = []
  }

  for (const e of events) {
    // A message does not end the wait; the call still waits on its connection.
    if (paused && e.type !== 'tool.deferred' && e.type !== 'input.received') {
      paused = false
      if (status === 'running') runningSince = e.createdAt
    }
    switch (e.type) {
      case 'run.state_changed':
        if (runningSince !== null) runningMs += Date.parse(e.createdAt) - Date.parse(runningSince)
        status = e.payload.to
        runningSince = status === 'running' ? e.createdAt : null
        waitingReason = status === 'waiting_human' ? ((e.payload.reason as WaitingReason | undefined) ?? null) : null
        waitStartedAt = status === 'waiting_human' ? e.createdAt : null
        waitExpiresAt = status === 'waiting_human' ? (e.payload.expiresAt ?? null) : null
        wakeAt = status === 'sleeping' ? (e.payload.wakeAt ?? null) : null
        if (status === 'sleeping' && e.payload.wakeAt !== undefined) followups++
        break
      case 'step.completed':
        // A workflow's result is the output of its last step.
        output = JSON.stringify(e.payload.output)
        break
      case 'limit.continued':
        limitGrants[e.payload.limit]++
        break
      case 'input.received':
        if (e.payload.action === 'cancel') {
          cancelRequested = true
          break
        }
        unreadMessages++
        held.push({ role: 'user', content: e.payload.text })
        flush()
        break
      case 'llm.requested':
        unreadMessages = 0
        llmOpen = true
        break
      case 'llm.responded':
        llmCalls++
        tokens += e.payload.usage.inputTokens + e.payload.usage.outputTokens
        costUsd += e.payload.usage.costUsd ?? 0
        llmRetry = { attempts: 0, retryAt: null }
        messages.push(e.payload.message)
        lastToolCalls = e.payload.message.toolCalls ?? []
        output = e.payload.stopReason === 'end' ? e.payload.message.content : null
        llmOpen = false
        flush()
        break
      case 'tool.deferred':
        if (runningSince !== null) runningMs += Date.parse(e.createdAt) - Date.parse(runningSince)
        runningSince = null
        paused = true
        {
          // Read through a typed local: TypeScript narrows the closure-assigned `deferral` to `never` here.
          const prev = deferral as RunProjection['deferral']
          deferral =
            prev?.toolCallId === e.payload.toolCallId
              ? { ...prev, count: prev.count + 1, retryAt: e.payload.retryAt }
              : { toolCallId: e.payload.toolCallId, count: 1, since: e.createdAt, retryAt: e.payload.retryAt }
        }
        break
      case 'tool.responded':
        if (deferral?.toolCallId === e.payload.toolCallId) deferral = null
        responded.add(e.payload.toolCallId)
        {
          const req = sent.get(e.payload.toolCallId)
          if (req !== undefined) {
            completedCalls.push({ toolCallId: e.payload.toolCallId, ...req, respondedAt: e.createdAt, payload: e.payload, labels: e.labels })
          }
        }
        messages.push({ role: 'tool', toolCallId: e.payload.toolCallId, content: e.payload.content })
        flush()
        break
      case 'tool.requested':
        if (deferral?.toolCallId === e.payload.toolCallId) deferral = null
        requested.add(e.payload.toolCallId)
        sentTools.push(e.payload.tool)
        sent.set(e.payload.toolCallId, { tool: e.payload.tool, args: e.payload.args, sentBefore: sentTools.length })
        break
      case 'step.started':
        if (e.payload.kind === 'subrun') sentTools.push(SUBRUN_STARTED)
        break
      case 'outcome.settled':
        settled.add(e.payload.toolCallId)
        // Not happened: the call goes back to pending and may run again. Happened changes nothing here;
        // the API also appends a `tool.responded`.
        if (e.payload.outcome === 'not_happened') requested.delete(e.payload.toolCallId)
        break
      case 'approval.requested':
        approvalRequested.add(e.payload.toolCallId)
        break
      case 'approval.resolved':
        approvals.set(e.payload.toolCallId, e.payload.action)
        break
      case 'rule.decided':
        // A new decision replaces the earlier one, and any approval given for it.
        approvals.delete(e.payload.toolCallId)
        approvalRequested.delete(e.payload.toolCallId)
        ruleDecisions.set(e.payload.toolCallId, e.payload.decision)
        ruleReasons.set(e.payload.toolCallId, e.payload.reason)
        break
      case 'error.raised':
        if (e.payload.retryAt !== undefined) llmRetry = { attempts: llmRetry.attempts + 1, retryAt: e.payload.retryAt }
        // Only an LLM call that failed is open here; a tool error never closes the LLM turn.
        if (llmOpen && !callsOpen()) {
          llmOpen = false
          flush()
        }
        break
      default:
        break
    }
  }

  return {
    status,
    waitingReason,
    messages,
    pendingToolCalls: lastToolCalls.filter((c) => !responded.has(c.id)),
    approvals,
    awaitingApproval: [...approvalRequested].filter((id) => !approvals.has(id)),
    inFlight: [...requested].filter((id) => !responded.has(id)),
    ruleDecisions,
    ruleReasons,
    llmCalls,
    llmRetry,
    tokens,
    costUsd,
    limitGrants,
    runningMs,
    runningSince,
    waitStartedAt,
    waitExpiresAt,
    wakeAt,
    followups,
    cancelRequested,
    unreadMessages,
    deferral,
    // A settled call's answer is a fixed text from a human, not a read result.
    completedCalls: completedCalls.filter((c) => !settled.has(c.toolCallId)),
    sentTools,
    lastSeq: events.at(-1)!.seq,
    output,
    principal: principal === undefined ? null : { id: principal.id, roles: principal.roles },
  }
}
