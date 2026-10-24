import { projectRun } from '@agent-core/core'
import type { RunStatus, WaitingReason } from '@agent-core/core'
import { PgRunStore, getRun } from '@agent-core/store-postgres'
import type { createPool } from '@agent-core/store-postgres'

type Pool = ReturnType<typeof createPool>

export type RunView = {
  id: string
  agent: string
  status: RunStatus
  waiting_reason: WaitingReason | null
  output: string | null
  pending_approval: { tool_call_id: string; tool: string; args: Record<string, unknown>; reason: string } | null
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
    ? events.find((e) => e.type === 'approval.requested' && e.payload.toolCallId === awaitingId)
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
  return {
    id: run.id,
    agent: run.agentId,
    status: run.status,
    waiting_reason: run.waitingReason,
    output: proj?.output ?? null,
    pending_approval: pending,
  }
}
