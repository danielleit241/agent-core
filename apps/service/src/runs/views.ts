import { messageChars, projectRun } from '@agent-core/core'
import type { Manifest } from '@agent-core/core'
import type { Message, RunStatus, StoredEvent, ToolDescriptor, Usage, WaitingReason } from '@agent-core/core'
import { PgContentStore, PgRunStore, getRun } from '@agent-core/store-postgres'
import type { createPool } from '@agent-core/store-postgres'

type Pool = ReturnType<typeof createPool>

export type RunView = {
  id: string
  agent: string
  status: RunStatus
  waiting_reason: WaitingReason | null
  output: string | null
  pending_approval: { tool_call_id: string; tool: string; args: Record<string, unknown>; reason: string } | null
  /** `reason` is the recorded evidence of why the outcome is unknown; null for runs logged before it existed. */
  pending_outcome: { tool_call_id: string; tool: string; args: Record<string, unknown>; reason: string | null } | null
}

/** The body of `GET /v1/runs/{id}`, or null when the run does not exist. */
export async function getRunView(pool: Pool, tenantId: string, runId: string): Promise<RunView | null> {
  const run = await getRun(pool, tenantId, runId)
  if (!run) return null
  const events = await new PgRunStore(pool, tenantId).readEvents(runId)
  // A run row can exist for a moment before its run.created event is appended.
  const proj = events.length > 0 ? projectRun(events, '') : null
  const awaitingId = proj?.awaitingApproval[0]
  const requested = awaitingId
    ? events.findLast((e) => e.type === 'approval.requested' && e.payload.toolCallId === awaitingId)
    : undefined
  const pending =
    requested?.type === 'approval.requested'
      ? {
          tool_call_id: requested.payload.toolCallId,
          tool: requested.payload.tool,
          args: requested.payload.args,
          reason: requested.payload.reason,
        }
      : null
  const inFlightId = run.waitingReason === 'unknown_outcome' ? proj?.inFlight[0] : undefined
  const sentAt = inFlightId ? events.findLastIndex((e) => e.type === 'tool.requested' && e.payload.toolCallId === inFlightId) : -1
  const sent = events[sentAt]
  const why = events.slice(sentAt + 1).findLast((e) => e.type === 'error.raised')
  const pendingOutcome =
    sentAt >= 0 && sent?.type === 'tool.requested'
      ? {
          tool_call_id: sent.payload.toolCallId,
          tool: sent.payload.tool,
          args: sent.payload.args,
          reason: why?.type === 'error.raised' ? why.payload.message : null,
        }
      : null
  return {
    id: run.id,
    agent: run.agentId,
    status: run.status,
    waiting_reason: run.waitingReason,
    output: proj?.output ?? null,
    pending_approval: pending,
    pending_outcome: pendingOutcome,
  }
}

export type LlmCallView = {
  seq: number
  model: string
  usage: Usage | null
  stopReason: string | null
  /** Parts sent in this call (messages and tools); 0 for a call logged without a snapshot. */
  parts: number
  /** Stored parts first seen in this call: a part sent again is stored once. The volatile time item is inline, never new. */
  newParts: number
  /** Characters sent per role and for the tool descriptors. Absent for a call without a snapshot. */
  chars?: Record<Message['role'] | 'tools', number>
}

/** Blobs by hash; a missing one is a broken store, not a client error. */
async function readBlobs(pool: Pool, tenantId: string, hashes: Iterable<string>): Promise<Map<string, string>> {
  const distinct = [...new Set(hashes)]
  const blobs = await new PgContentStore(pool, tenantId).get(distinct)
  if (blobs.size < distinct.length) throw new Error('context blob missing')
  return blobs
}

async function readManifests(pool: Pool, tenantId: string, events: StoredEvent[]): Promise<Map<string, Manifest>> {
  const hashes = events.flatMap((e) => (e.type === 'llm.requested' && e.payload.context ? [e.payload.context.snapshot] : []))
  const blobs = await readBlobs(pool, tenantId, hashes)
  return new Map([...blobs].map(([h, text]) => [h, JSON.parse(text) as Manifest]))
}

/** The body of `GET /v1/runs/{id}/llm-calls`, or null when the run does not exist. */
export async function getLlmCalls(pool: Pool, tenantId: string, runId: string): Promise<{ calls: LlmCallView[] } | null> {
  if (!(await getRun(pool, tenantId, runId))) return null
  const events = await new PgRunStore(pool, tenantId).readEvents(runId)
  const manifests = await readManifests(pool, tenantId, events)
  const partHashes = [...manifests.values()].flatMap((m) => [...m.tools, ...m.messages.filter((x): x is string => typeof x === 'string')])
  const blobs = await readBlobs(pool, tenantId, partHashes)
  // Each distinct part is parsed once; calls that repeat it reuse the result.
  const messageInfo = new Map<string, { role: Message['role']; chars: number }>()
  const infoOf = (partText: string): { role: Message['role']; chars: number } => {
    const m = JSON.parse(partText) as Message
    return { role: m.role, chars: messageChars(m) }
  }
  const seen = new Set<string>()
  const calls: LlmCallView[] = []
  // One forward pass: a response belongs to the latest request before it. A request with no response before the next
  // request (a retry, or a crash mid-call) keeps null.
  let open: LlmCallView | null = null
  for (const e of events) {
    if (e.type === 'llm.responded') {
      if (open !== null) {
        open.usage = e.payload.usage
        open.stopReason = e.payload.stopReason
        open = null
      }
      continue
    }
    if (e.type !== 'llm.requested') continue
    const call: LlmCallView = { seq: e.seq, model: e.payload.model, usage: null, stopReason: null, parts: 0, newParts: 0 }
    calls.push(call)
    open = call
    const manifest = e.payload.context === undefined ? undefined : manifests.get(e.payload.context.snapshot)
    if (manifest === undefined) continue
    const chars = { system: 0, user: 0, assistant: 0, tool: 0, tools: 0 }
    const stored = [...manifest.tools]
    for (const x of manifest.messages) {
      let info: { role: Message['role']; chars: number }
      if (typeof x === 'string') {
        stored.push(x)
        info = messageInfo.get(x) ?? infoOf(blobs.get(x)!)
        messageInfo.set(x, info)
      } else info = infoOf(x.inline)
      chars[info.role] += info.chars
    }
    for (const h of manifest.tools) chars.tools += blobs.get(h)!.length
    const before = seen.size
    for (const h of stored) seen.add(h)
    call.parts = manifest.messages.length + manifest.tools.length
    call.newParts = seen.size - before
    call.chars = chars
  }
  return { calls }
}

/** The body of `GET /v1/runs/{id}/llm-calls/{seq}`, or null when the run or the snapshot does not exist. */
export async function getLlmCall(
  pool: Pool,
  tenantId: string,
  runId: string,
  seq: number,
): Promise<{
  seq: number
  model: string
  messages: Message[]
  tools: Pick<ToolDescriptor, 'name' | 'description' | 'inputSchema'>[]
  output?: { name: string; schema: unknown }
} | null> {
  if (!(await getRun(pool, tenantId, runId))) return null
  const events = await new PgRunStore(pool, tenantId).readEvents(runId)
  const e = events.find((x) => x.seq === seq)
  if (e?.type !== 'llm.requested' || e.payload.context === undefined) return null
  const manifest = (await readManifests(pool, tenantId, [e])).get(e.payload.context.snapshot)!
  const blobs = await readBlobs(pool, tenantId, [...manifest.tools, ...manifest.messages.filter((x): x is string => typeof x === 'string')])
  const parse = <T>(text: string): T => JSON.parse(text) as T
  return {
    seq,
    model: e.payload.model,
    messages: manifest.messages.map((x) => parse<Message>(typeof x === 'string' ? blobs.get(x)! : x.inline)),
    tools: manifest.tools.map((h) => parse<ToolDescriptor>(blobs.get(h)!)),
    ...(manifest.output === undefined ? {} : { output: manifest.output }),
  }
}
