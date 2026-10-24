import type { RunStatus } from '@agent-core/core'
import { getRunHead } from '@agent-core/store-postgres'
import type { createPool } from '@agent-core/store-postgres'
import { enqueueWebhookEvent } from '@agent-core/webhooks'
import type { WebhookEventType } from '@agent-core/webhooks'
import { getRunView } from './views'

type Pool = ReturnType<typeof createPool>

const TENANT = 'default'

/** Builds the `onRunSettled` callback: it queues a webhook delivery for each subscriber of the matching event. */
export function createRunSettledHandler(pool: Pool): (runId: string, status: RunStatus) => Promise<void> {
  return async (runId, status) => {
    const view = await getRunView(pool, TENANT, runId)
    if (!view) return
    let type: WebhookEventType | null = null
    if (status === 'completed') type = 'run.completed'
    else if (status === 'failed') type = 'run.failed'
    else if (status === 'waiting_human' && view.waiting_reason === 'approval') type = 'approval.requested'
    if (!type) return
    const head = await getRunHead(pool, TENANT, runId)
    if (head?.lastSeq == null) return
    const { id, ...rest } = view
    // Deterministic id: the worker may run this again after a crash, and the unique index drops the repeat.
    await enqueueWebhookEvent(pool, TENANT, type, { run_id: id, ...rest }, `evt_${runId}_${head.lastSeq}_${type}`)
  }
}
