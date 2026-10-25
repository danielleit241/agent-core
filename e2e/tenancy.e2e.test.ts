import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, test } from 'vitest'
import { verifyWebhook } from '@agent-core/protocol'
import { startShop } from '@agent-core/shop'
import { startStack } from './support/harness'
import type { Received, Stack } from './support/harness'

let stack: Stack | undefined
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  await stack?.close()
  stack = undefined
  await Promise.all(closers.splice(0).map((close) => close()))
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

async function startReceiver(): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      res.writeHead(200).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, received }
}

async function createTenantKey(s: Stack, id: string): Promise<string> {
  const res = await s.api('POST', '/v1/tenants', { id })
  expect(res.status).toBe(201)
  return res.body.api_key as string
}

test("a completed run delivers only to its own tenant, signed with that tenant's secret", async () => {
  const s = (stack = await startStack([{ content: 'a done' }, { content: 'b done' }]))
  const keyA = await createTenantKey(s, 'a')
  const keyB = await createTenantKey(s, 'b')
  const recvA = await startReceiver()
  const recvB = await startReceiver()
  const hookA = await s.apiForTenant('a', 'POST', '/v1/webhooks', { url: recvA.url, events: ['run.completed'] })
  const hookB = await s.apiForTenant('b', 'POST', '/v1/webhooks', { url: recvB.url, events: ['run.completed'] })
  expect(hookA.status).toBe(201)
  expect(hookB.status).toBe(201)
  for (const key of [keyA, keyB]) {
    await s.apiAs(key, 'POST', '/v1/agents', { id: 'helper', instructions: 'help', connections: [], autonomy: 'supervised', allow: [] })
  }

  const runA = await s.apiAs(keyA, 'POST', '/v1/runs?wait=10', { agent: 'helper', input: { text: 'hi' } })
  expect(runA.body.status).toBe('completed')
  await waitFor(() => recvA.received.length === 1)
  const runB = await s.apiAs(keyB, 'POST', '/v1/runs?wait=10', { agent: 'helper', input: { text: 'hi' } })
  expect(runB.body.status).toBe('completed')
  await waitFor(() => recvB.received.length === 1)

  const sigOf = (r: Received): string => r.headers['x-agentcore-signature'] as string
  const onlyA = recvA.received[0]!
  const onlyB = recvB.received[0]!
  expect(recvA.received).toHaveLength(1)
  expect(recvB.received).toHaveLength(1)
  expect(JSON.parse(onlyA.body).data.run_id).toBe(runA.body.id)
  expect(JSON.parse(onlyB.body).data.run_id).toBe(runB.body.id)
  expect(verifyWebhook(onlyA.body, sigOf(onlyA), hookA.body.secret, nowSec())).toBe(true)
  expect(verifyWebhook(onlyA.body, sigOf(onlyA), hookB.body.secret, nowSec())).toBe(false)
  expect(verifyWebhook(onlyB.body, sigOf(onlyB), hookB.body.secret, nowSec())).toBe(true)
})

test('an agent of b that names a connection of a is rejected with unknown_connection', async () => {
  const s = (stack = await startStack([]))
  await createTenantKey(s, 'a')
  const keyB = await createTenantKey(s, 'b')
  expect((await s.apiForTenant('a', 'POST', '/v1/connections', { id: 'shop', url: s.shop.url })).status).toBe(201)

  const res = await s.apiAs(keyB, 'POST', '/v1/agents', {
    id: 'helper',
    instructions: 'help',
    connections: ['shop'],
    autonomy: 'supervised',
    allow: [],
  })
  expect(res.status).toBe(422)
  expect(res.body.error.code).toBe('unknown_connection')
})

test('two tenants with the same connection id call only their own shop', async () => {
  const refund = (orderId: string, amount: number) => ({ toolCalls: [{ name: 'payments.refund', arguments: { order_id: orderId, amount } }] })
  const s = (stack = await startStack([refund('1050', 100), { content: 'a done' }, refund('1042', 200), { content: 'b done' }]))
  const shopA = s.shop
  const shopB = await startShop()
  closers.push(() => shopB.close())
  const keys = { a: await createTenantKey(s, 'a'), b: await createTenantKey(s, 'b') }

  for (const [tenant, shop] of [
    ['a', shopA],
    ['b', shopB],
  ] as const) {
    const key = keys[tenant]
    const conn = await s.apiForTenant(tenant, 'POST', '/v1/connections', { id: 'shop', url: shop.url })
    expect(conn.status).toBe(201)
    for (const t of conn.body.tools as { name: string }[]) {
      const res = await s.apiAs(key, 'PATCH', `/v1/connections/shop/tools/${encodeURIComponent(t.name)}`, { confirm: 'proposed' })
      expect(res.status).toBeLessThan(300)
    }
    await s.apiAs(key, 'POST', '/v1/agents', {
      id: 'helper',
      instructions: 'help',
      connections: ['shop'],
      autonomy: 'supervised',
      allow: [{ tool: 'payments.refund' }],
    })
  }

  const runA = await s.apiAs(keys.a, 'POST', '/v1/runs?wait=10', { agent: 'helper', input: { text: 'refund' } })
  expect(runA.body.status).toBe('completed')
  expect(shopA.state.refunds).toEqual([{ orderId: '1050', amount: 100 }])
  expect(shopB.state.refunds).toEqual([])

  const runB = await s.apiAs(keys.b, 'POST', '/v1/runs?wait=10', { agent: 'helper', input: { text: 'refund' } })
  expect(runB.body.status).toBe('completed')
  expect(shopB.state.refunds).toEqual([{ orderId: '1042', amount: 200 }])
  expect(shopA.state.refunds).toEqual([{ orderId: '1050', amount: 100 }])
})
