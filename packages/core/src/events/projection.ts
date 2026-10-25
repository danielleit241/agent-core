import type { Message, RunStatus, StoredEvent, ToolCall, WaitingReason } from '../types'

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
  const responded = new Set<string>()
  const requested = new Set<string>()
  const approvalRequested = new Set<string>()
  const approvals: RunProjection['approvals'] = new Map()
  const ruleDecisions: RunProjection['ruleDecisions'] = new Map()
  const ruleReasons: RunProjection['ruleReasons'] = new Map()

  for (const e of events) {
    switch (e.type) {
      case 'run.state_changed':
        status = e.payload.to
        waitingReason = e.payload.to === 'waiting_human' ? ((e.payload.reason as WaitingReason | undefined) ?? null) : null
        break
      case 'llm.responded':
        llmCalls++
        messages.push(e.payload.message)
        lastToolCalls = e.payload.message.toolCalls ?? []
        output = e.payload.stopReason === 'end' ? e.payload.message.content : null
        break
      case 'tool.responded':
        responded.add(e.payload.toolCallId)
        messages.push({ role: 'tool', toolCallId: e.payload.toolCallId, content: e.payload.content })
        break
      case 'tool.requested':
        requested.add(e.payload.toolCallId)
        break
      case 'outcome.settled':
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
    output,
    principal: principal === undefined ? null : { id: principal.id, roles: principal.roles },
  }
}
