import { afterEach, expect, test } from 'vitest'
import type { FakeTurn } from '@agent-core/fake-llm'
import { startStack } from './support/harness'
import type { Stack } from './support/harness'
import { registerShop } from './support/setup'

let stack: Stack | undefined
afterEach(async () => {
  await stack?.close()
  stack = undefined
})

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('waitFor timed out')
}

const script: FakeTurn[] = [
  { toolCalls: [{ name: 'payments.refund', arguments: { order_id: '1042', amount: 1200000 } }] },
  { content: 'Đã xử lý hoàn tiền đơn #1042.' },
]

/** Runs a refund that the human approved while the shop loses its response: the run waits with `unknown_outcome`. */
async function reachUnknownOutcome(s: Stack): Promise<string> {
  await registerShop(s)
  await s.api('POST', '/v1/agents', {
    id: 'retail-support',
    instructions: 'Bạn là trợ lý của Cửa hàng Mộc.',
    connections: ['shop'],
    autonomy: 'supervised',
    allow: [],
  })
  await s.api('POST', '/v1/webhooks', { url: s.receiver.url, events: ['run.waiting_human', 'run.completed'] })
  const run = await s.api('POST', '/v1/runs?wait=10', { agent: 'retail-support', input: { text: 'Hoàn tiền đơn 1042' } })
  expect(run.body).toMatchObject({ status: 'waiting_human', waiting_reason: 'approval' })
  s.shop.failNextResponseAfterExecute()
  expect((await s.api('POST', `/v1/runs/${run.body.id}/resolve`, { action: 'approve' })).status).toBe(202)
  await waitFor(async () => (await s.api('GET', `/v1/runs/${run.body.id}`)).body.waiting_reason === 'unknown_outcome')
  return run.body.id as string
}

const eventsOf = async (s: Stack, id: string) =>
  (await s.api('GET', `/v1/runs/${id}/events`)).body.events as { type: string; payload: Record<string, unknown> }[]
const typeOf = (r: { body: string }): string => (JSON.parse(r.body) as { type: string }).type

test('outcome_happened completes the run without a second refund', async () => {
  const s = (stack = await startStack(script))
  const id = await reachUnknownOutcome(s)
  const view = await s.api('GET', `/v1/runs/${id}`)
  expect(view.body.pending_outcome).toMatchObject({
    tool: 'payments.refund',
    args: { amount: 1200000 },
    reason: 'The tool call failed after it was sent (tool_call_failed). It may have run.',
  })
  await waitFor(() => s.receiver.received.some((r) => typeOf(r) === 'run.waiting_human'))
  expect(s.shop.state.refunds).toHaveLength(1)

  expect((await s.api('POST', `/v1/runs/${id}/resolve`, { action: 'outcome_happened' })).status).toBe(202)
  await waitFor(async () => (await s.api('GET', `/v1/runs/${id}`)).body.status === 'completed')
  expect(s.shop.state.refunds).toHaveLength(1)
  expect((await eventsOf(s, id)).filter((e) => e.type === 'tool.requested')).toHaveLength(1)
})

test('outcome_not_happened runs the tool again with the same idempotency key', async () => {
  const s = (stack = await startStack(script))
  const id = await reachUnknownOutcome(s)

  expect((await s.api('POST', `/v1/runs/${id}/resolve`, { action: 'outcome_not_happened' })).status).toBe(202)
  await waitFor(async () => (await s.api('GET', `/v1/runs/${id}`)).body.status === 'completed')
  expect(s.shop.state.refunds).toHaveLength(2)
  const requested = (await eventsOf(s, id)).filter((e) => e.type === 'tool.requested')
  expect(requested).toHaveLength(2)
  expect(requested[0]!.payload.idempotencyKey).toBe(requested[1]!.payload.idempotencyKey)
})

test('cancel ends the run and calls the model no more', async () => {
  const s = (stack = await startStack(script))
  const id = await reachUnknownOutcome(s)
  const llmCalls = async () => (await eventsOf(s, id)).filter((e) => e.type === 'llm.responded').length
  const before = await llmCalls()

  const res = await s.api('POST', `/v1/runs/${id}/resolve`, { action: 'cancel' })
  expect(res.status).toBe(202)
  expect(res.body).toEqual({ run_id: id, status: 'cancelled' })
  await new Promise((r) => setTimeout(r, 300))
  expect((await s.api('GET', `/v1/runs/${id}`)).body.status).toBe('cancelled')
  expect(await llmCalls()).toBe(before)
  expect(s.shop.state.refunds).toHaveLength(1)
})
