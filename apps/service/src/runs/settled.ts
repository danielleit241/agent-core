import type { RunStatus } from '@agent-core/core'
import { getRunHead, withTenant } from '@agent-core/store-postgres'
import type { createPool } from '@agent-core/store-postgres'
import { enqueueWebhookEvent } from '@agent-core/webhooks'
import type { WebhookEventType } from '@agent-core/webhooks'
import { getRunView } from './views'

type Pool = ReturnType<typeof createPool>

/** Builds the `onRunSettled` callback: it queues a webhook delivery for each subscriber of the matching event. */
export function createRunSettledHandler(pool: Pool): (runId: string, tenantId: string, status: RunStatus) => Promise<void> {
  return async (runId, tenantId, status) => {
    const view = await getRunView(pool, tenantId, runId)
    if (!view) return
    let type: WebhookEventType | null = null
    if (status === 'completed') type = 'run.completed'
    else if (status === 'failed') type = 'run.failed'
    else if (status === 'waiting_human') type = view.waiting_reason === 'approval' ? 'approval.requested' : 'run.waiting_human'
    if (!type) return
    const head = await getRunHead(pool, tenantId, runId)
    if (head?.lastSeq == null) return
    const { id, ...rest } = view
    // Deterministic id: the worker may run this again after a crash, and the unique index drops the repeat.
    const eventId = `evt_${runId}_${head.lastSeq}_${type}`
    await withTenant(pool, tenantId, (db) => enqueueWebhookEvent(db, tenantId, type, { run_id: id, ...rest }, eventId))
  }
}
