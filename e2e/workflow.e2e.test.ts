import { afterEach, expect, test } from 'vitest'
import { startStack } from './support/harness'
import type { Stack } from './support/harness'
import { registerShop } from './support/setup'

let stack: Stack | undefined
afterEach(async () => {
  await stack?.close()
  stack = undefined
})

async function waitForStatus(s: Stack, runId: string, status: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await s.api('GET', `/v1/runs/${runId}`)).body.status === status) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`run ${runId} did not reach ${status}`)
}

const refundDesk = {
  id: 'refund-desk',
  instructions: 'You run the refund desk of Cửa hàng Mộc.',
  connections: ['shop'],
  autonomy: 'supervised',
  allow: [{ tool: 'payments.refund' }],
  workflows: {
    refund: {
      start: 'lookup',
      steps: {
        lookup: { kind: 'tool', tool: 'orders.get', args: { order_id: { $ref: '$input.text' } }, next: 'check' },
        check: {
          kind: 'approval',
          reason: 'Refund this order in full?',
          next: { when: [{ field: 'approved', is: { eq: true }, goto: 'refund' }] },
        },
        refund: { kind: 'tool', tool: 'payments.refund', args: { order_id: { $ref: '$input.text' }, amount: { $ref: 'lookup.amount' } } },
      },
    },
  },
}

test('a refund workflow looks up the order, waits for approval, then refunds the amount it looked up', async () => {
  stack = await startStack([])
  await registerShop(stack)
  expect((await stack.api('POST', '/v1/agents', refundDesk)).status).toBe(201)

  const run = await stack.api('POST', '/v1/runs', { agent: 'refund-desk', workflow: 'refund', input: { text: '1042' } })
  expect(run.status).toBe(202)
  const runId = run.body.run_id as string
  await waitForStatus(stack, runId, 'waiting_human')
  const waiting = await stack.api('GET', `/v1/runs/${runId}`)
  expect(waiting.body).toMatchObject({
    waiting_reason: 'approval',
    pending_approval: { tool_call_id: 'step:check', tool: 'approval', reason: 'Refund this order in full?' },
  })
  expect(stack.shop.state.refunds).toEqual([])

  expect((await stack.api('POST', `/v1/runs/${runId}/input`, { action: 'approve' })).status).toBe(202)
  await waitForStatus(stack, runId, 'completed')
  expect(stack.shop.state.refunds).toEqual([{ orderId: '1042', amount: 1200000 }])
  const done = await stack.api('GET', `/v1/runs/${runId}`)
  expect(JSON.parse(done.body.output)).toEqual({ text: 'Refunded 1200000 for order 1042' })
})
