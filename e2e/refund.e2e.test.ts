import { afterEach, expect, test } from 'vitest'
import { verifyWebhook } from '@agent-core/webhooks'
import type { FakeTurn } from '@agent-core/fake-llm'
import { startStack } from './support/harness'
import type { Stack } from './support/harness'
import { registerShop } from './support/setup'

let stack: Stack | undefined
afterEach(async () => {
  await stack?.close()
  stack = undefined
})

const nowSec = (): number => Math.floor(Date.now() / 1000)

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('waitFor timed out')
}

const typeOf = (r: { body: string }): string => (JSON.parse(r.body) as { type: string }).type
const delivered = (s: Stack, type: string): boolean => s.receiver.received.some((r) => typeOf(r) === type)
const lastOf = (s: Stack, type: string) => s.receiver.received.filter((r) => typeOf(r) === type).at(-1)!

async function setup(s: Stack): Promise<{ secret: string }> {
  const conn = await s.api('POST', '/v1/connections', { id: 'shop', url: s.shop.url })
  const tools = conn.body.tools as { name: string; safety: { effect: string }; needsConfirmation: string[] }[]
  // Before confirming, every tool runs as a write; only the proposal says read.
  expect(tools.map((t) => [t.name, t.safety.effect])).toEqual([
    ['orders.get', 'write'],
    ['payments.refund', 'write'],
    ['inventory.check', 'write'],
    ['orders.change_size', 'write'],
  ])
  expect(tools.find((t) => t.name === 'orders.get')!.needsConfirmation).toContain('effect')
  await registerShop(s)
  const confirmed = await s.api('GET', '/v1/connections/shop/tools')
  expect(confirmed.body.tools.map((t: { name: string; safety: { effect: string } }) => [t.name, t.safety.effect])).toEqual([
    ['orders.get', 'read'],
    ['payments.refund', 'write'],
    ['inventory.check', 'read'],
    ['orders.change_size', 'write'],
  ])
  await s.api('POST', '/v1/agents', {
    id: 'retail-support',
    instructions: 'Bạn là trợ lý của Cửa hàng Mộc.',
    connections: ['shop'],
    autonomy: 'supervised',
    allow: [{ tool: 'payments.refund', when: { amount: { lte: 1000000 } } }],
  })
  const hook = await s.api('POST', '/v1/webhooks', { url: s.receiver.url, events: ['approval.requested', 'run.completed'] })
  return { secret: hook.body.secret }
}

const startRun = (s: Stack, text: string) =>
  s.api('POST', '/v1/runs?wait=10', { agent: 'retail-support', input: { text }, principal: { id: 'cus_2291', roles: ['customer'] } })

const refundScript = (orderId: string, amount: number, final: string): FakeTurn[] => [
  { toolCalls: [{ name: 'orders.get', arguments: { order_id: orderId } }] },
  { toolCalls: [{ name: 'payments.refund', arguments: { order_id: orderId, amount } }] },
  { content: final },
]

test('refund over the limit: wait, approve, complete, notify, verify', async () => {
  const s = (stack = await startStack(refundScript('1042', 1200000, 'Đã hoàn 1.200.000đ cho đơn #1042.'), { receiverStatuses: [500, 200, 200] }))
  const { secret } = await setup(s)

  const run = await startRun(s, 'Áo lỗi, hoàn tiền đơn 1042')
  expect(run.body).toMatchObject({ status: 'waiting_human', waiting_reason: 'approval', pending_approval: { tool: 'payments.refund', args: { amount: 1200000 } } })
  expect(s.shop.state.refunds).toEqual([])

  // The first delivery got a 500; the run stays waiting and the delivery is retried.
  await waitFor(() => s.receiver.received.filter((r) => typeOf(r) === 'approval.requested').length >= 2)
  const approvalHook = lastOf(s, 'approval.requested')
  expect(verifyWebhook(approvalHook.body, approvalHook.headers['x-agentcore-signature'] as string, secret, nowSec())).toBe(true)

  expect((await s.api('POST', `/v1/runs/${run.body.id}/resolve`, { action: 'approve' })).status).toBe(202)
  await waitFor(async () => (await s.api('GET', `/v1/runs/${run.body.id}`)).body.status === 'completed')

  expect(s.shop.state.refunds).toEqual([{ orderId: '1042', amount: 1200000 }])
  expect((await s.api('GET', `/v1/runs/${run.body.id}`)).body.output).toBe('Đã hoàn 1.200.000đ cho đơn #1042.')
  await waitFor(() => delivered(s, 'run.completed'))
  const log = await s.api('GET', `/v1/runs/${run.body.id}/events`)
  expect(log.body.chain).toEqual({ valid: true })
})

test('refund under the limit completes without approval', async () => {
  const s = (stack = await startStack(refundScript('1050', 500000, 'Đã hoàn 500.000đ cho đơn #1050.')))
  await setup(s)

  const run = await startRun(s, 'Hoàn tiền đơn 1050')
  expect(run.body).toMatchObject({ status: 'completed', output: 'Đã hoàn 500.000đ cho đơn #1050.', pending_approval: null })
  expect(s.shop.state.refunds).toEqual([{ orderId: '1050', amount: 500000 }])

  await waitFor(() => delivered(s, 'run.completed'))
  expect(delivered(s, 'approval.requested')).toBe(false)
})

test('rejected refund never reaches the shop', async () => {
  const s = (stack = await startStack(refundScript('1042', 1200000, 'Yêu cầu hoàn tiền đã bị từ chối.')))
  await setup(s)

  const run = await startRun(s, 'Áo lỗi, hoàn tiền đơn 1042')
  expect(run.body.status).toBe('waiting_human')

  expect((await s.api('POST', `/v1/runs/${run.body.id}/resolve`, { action: 'reject' })).status).toBe(202)
  await waitFor(async () => (await s.api('GET', `/v1/runs/${run.body.id}`)).body.status === 'completed')
  expect(s.shop.state.refunds).toEqual([])
})
