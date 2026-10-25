import { projectRun } from '@agent-core/core'
import type { RunStatus, StoredEvent, WaitingReason } from '@agent-core/core'
import type { EvalStack } from './stack'
import type { Outcome, Scenario } from './scenario'

const WAIT_SECONDS = 30
const TOTAL_LIMIT_MS = 120_000
const STOP_LIMIT_MS = 60_000
const POLL_MS = 100

/**
 * A run outlived its scenario and could not be stopped. It may still call tools on the shared shop,
 * so no later scenario can be graded fairly.
 */
export class StackUnsafeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StackUnsafeError'
  }
}

const isActive = (status: RunStatus) => status === 'queued' || status === 'running'

type View = {
  id: string
  status: RunStatus
  waiting_reason: WaitingReason | null
  output: string | null
  pending_approval: { tool: string } | null
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Cancels a run that missed its deadline and waits until it can do nothing more. A running run cannot be
 * cancelled, so it is cancelled again each time it stops to wait. Throws StackUnsafeError when it keeps running.
 */
async function stopRun(stack: EvalStack, id: string, limitMs: number): Promise<void> {
  const deadline = Date.now() + limitMs
  for (;;) {
    const res = await stack.api('GET', `/v1/runs/${id}`)
    const status = (res.body as View).status
    if (status === 'waiting_human' || status === 'queued') await stack.api('POST', `/v1/runs/${id}/cancel`)
    else if (!isActive(status)) return
    if (Date.now() >= deadline) throw new StackUnsafeError(`run ${id} is still ${status} ${limitMs / 1000}s after its scenario ended`)
    await sleep(POLL_MS)
  }
}

/** Runs one scenario against the stack and returns what happened. Throws when the run cannot be graded. */
export async function runScenario(
  stack: EvalStack,
  s: Scenario,
  limits: { totalMs?: number; stopMs?: number } = {},
): Promise<Outcome> {
  const totalMs = limits.totalMs ?? TOTAL_LIMIT_MS
  const deadline = Date.now() + totalMs
  stack.shop.reset(s.fixture)
  const wait = Math.min(WAIT_SECONDS, Math.max(1, Math.floor(totalMs / 1000)))
  const created = await stack.api('POST', `/v1/runs?wait=${wait}`, {
    agent: 'shop',
    input: s.input,
    ...(s.principal ? { principal: s.principal } : {}),
  })
  if (created.status !== 200) throw new Error(`POST /v1/runs failed: ${created.status} ${JSON.stringify(created.body)}`)
  let view = created.body as View

  for (;;) {
    if (view.status === 'waiting_human' && view.waiting_reason === 'approval') {
      const tool = view.pending_approval?.tool
      const action = (tool !== undefined && s.approvals[tool]) || 'reject'
      const res = await stack.api('POST', `/v1/runs/${view.id}/resolve`, { action })
      if (res.status !== 202) throw new Error(`resolve failed: ${res.status} ${JSON.stringify(res.body)}`)
    } else if (view.status !== 'queued' && view.status !== 'running') {
      break // terminal, or waiting for something other than an approval
    }
    if (Date.now() >= deadline) {
      // Left alone, the run would keep calling the shop while the next scenario runs.
      await stopRun(stack, view.id, limits.stopMs ?? STOP_LIMIT_MS)
      throw new Error(`scenario ${s.id} did not settle within ${totalMs / 1000}s; run ${view.id} was cancelled`)
    }
    await sleep(POLL_MS)
    const next = await stack.api('GET', `/v1/runs/${view.id}`)
    if (next.status !== 200) throw new Error(`GET /v1/runs/${view.id} failed: ${next.status}`)
    view = next.body as View
  }

  const events = (await stack.api('GET', `/v1/runs/${view.id}/events`)).body.events as StoredEvent[]
  return {
    status: view.status,
    events,
    output: projectRun(events, '').output ?? view.output,
    shop: stack.shop.snapshot(),
  }
}
