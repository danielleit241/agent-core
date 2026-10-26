import { afterEach, expect, test } from 'vitest'
import { startStack } from './support/harness'
import type { Stack } from './support/harness'
import { registerShop } from './support/setup'

let stack: Stack | undefined
afterEach(async () => {
  await stack?.close()
  stack = undefined
})

type Event = { type: string; payload: Record<string, unknown> }

async function run(s: Stack): Promise<Event[]> {
  await registerShop(s)
  await s.api('POST', '/v1/agents', {
    id: 'retail-support',
    instructions: 'Bạn là trợ lý của Cửa hàng Mộc.',
    connections: ['shop'],
    autonomy: 'supervised',
    allow: [{ tool: 'payments.refund', when: { amount: { lte: 1000000 } } }],
  })
  const res = await s.api('POST', '/v1/runs?wait=10', { agent: 'retail-support', input: { text: 'Đơn 1042 thế nào?' } })
  expect(res.body.status).toBe('completed')
  return (await s.api('GET', `/v1/runs/${res.body.id}/events`)).body.events as Event[]
}
const sentTools = (events: Event[]) => events.filter((e) => e.type === 'tool.requested').map((e) => e.payload.tool)
const read = { name: 'orders.get', arguments: { order_id: '1042' } }

test('two identical reads call the shop once; the second is a cache hit', async () => {
  const s = (stack = await startStack([{ toolCalls: [read] }, { toolCalls: [read] }, { content: 'Đã giao.' }]))
  const events = await run(s)
  expect(sentTools(events)).toEqual(['orders.get'])
  expect(events.filter((e) => e.type === 'tool.cache_hit')).toHaveLength(1)
  const [first, second] = events.filter((e) => e.type === 'tool.responded')
  expect(second!.payload.content).toBe(first!.payload.content)
})

test('read, write (approved by the allow rule), read calls the shop twice', async () => {
  const s = (stack = await startStack([
    { toolCalls: [read] },
    { toolCalls: [{ name: 'payments.refund', arguments: { order_id: '1042', amount: 500000 } }] },
    { toolCalls: [read] },
    { content: 'Xong.' },
  ]))
  const events = await run(s)
  expect(sentTools(events)).toEqual(['orders.get', 'payments.refund', 'orders.get'])
  expect(events.some((e) => e.type === 'tool.cache_hit')).toBe(false)
  expect(s.shop.state.refunds).toEqual([{ orderId: '1042', amount: 500000 }])
})

test('cache_ttl_s 0 turns the cache off for the tool', async () => {
  const s = (stack = await startStack([{ toolCalls: [read] }, { toolCalls: [read] }, { content: 'Đã giao.' }]))
  await registerShop(s)
  expect((await s.api('PATCH', '/v1/connections/shop/tools/orders.get', { cache_ttl_s: 0 })).status).toBe(200)
  const events = await run(s)
  expect(sentTools(events)).toEqual(['orders.get', 'orders.get'])
  expect(events.some((e) => e.type === 'tool.cache_hit')).toBe(false)
})
