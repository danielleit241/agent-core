import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { startShop } from '../src/index.js'

type Shop = Awaited<ReturnType<typeof startShop>>
let shop: Shop
let client: Client

beforeEach(async () => {
  shop = await startShop()
  client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(shop.url)))
})

afterEach(async () => {
  await client.close()
  await shop.close()
})

const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] }
  return { isError: r.isError === true, text: r.content[0]!.text }
}

it('lists the four tools in registration order', async () => {
  const { tools } = await client.listTools()
  expect(tools.map((t) => t.name)).toEqual(['orders.get', 'payments.refund', 'inventory.check', 'orders.change_size'])
})

it('inventory.check returns the quantity, 0 when unknown', async () => {
  expect(await call('inventory.check', { sku: 'tee-basic', size: 'L' })).toEqual({
    isError: false,
    text: JSON.stringify({ sku: 'tee-basic', size: 'L', quantity: 2 }),
  })
  expect(JSON.parse((await call('inventory.check', { sku: 'nope', size: 'XL' })).text).quantity).toBe(0)
})

it('orders.change_size moves stock and records the change', async () => {
  expect(await call('orders.change_size', { order_id: '1042', size: 'L' })).toEqual({
    isError: false,
    text: 'Changed order 1042 to size L',
  })
  const snap = shop.snapshot()
  expect(snap.orders['1042']!.size).toBe('L')
  expect(snap.inventory['tee-basic:L']).toBe(1)
  expect(snap.inventory['tee-basic:M']).toBe(4)
  expect(snap.sizeChanges).toEqual([{ orderId: '1042', from: 'M', to: 'L' }])
})

it('orders.change_size reports out of stock and unknown orders without changing anything', async () => {
  const before = shop.snapshot()
  expect(await call('orders.change_size', { order_id: '1042', size: 'S' })).toEqual({
    isError: true,
    text: 'Out of stock: tee-basic size S',
  })
  expect(await call('orders.change_size', { order_id: '9999', size: 'L' })).toEqual({
    isError: true,
    text: 'Order not found: 9999',
  })
  expect(shop.snapshot()).toEqual(before)
})

it('reset() restores the default seed and clears refunds and size changes', async () => {
  const before = shop.snapshot()
  await call('payments.refund', { order_id: '1050', amount: 500000 })
  await call('orders.change_size', { order_id: '1042', size: 'L' })
  shop.reset()
  expect(shop.snapshot()).toEqual(before)
  expect(shop.state.refunds).toEqual([])
})

it('reset(seed) uses a copy of the seed', async () => {
  const seed = {
    orders: { A1: { status: 'delivered', amount: 10, customerId: 'c', sku: 'hat', size: 'S' } },
    inventory: { 'hat:S': 1, 'hat:M': 5 },
  }
  shop.reset(seed)
  expect(Object.keys(shop.snapshot().orders)).toEqual(['A1'])
  await call('orders.change_size', { order_id: 'A1', size: 'M' })
  expect(shop.snapshot().inventory).toEqual({ 'hat:S': 2, 'hat:M': 4 })
  expect(seed.orders.A1.size).toBe('S')
  expect(seed.inventory).toEqual({ 'hat:S': 1, 'hat:M': 5 })
})

it('orders.change_size refuses the current size and an order without a size', async () => {
  shop.reset({ orders: { '7': { status: 'delivered', amount: 1, customerId: 'c' } } })
  const before = shop.snapshot()
  expect(await call('orders.change_size', { order_id: '7', size: 'L' })).toEqual({ isError: true, text: 'Order 7 has no size to change' })
  shop.reset()
  expect(await call('orders.change_size', { order_id: '1042', size: 'M' })).toEqual({ isError: true, text: 'Order 1042 is already size M' })
  expect(shop.snapshot().sizeChanges).toEqual([])
  expect(before.sizeChanges).toEqual([])
})

it('the warehouse endpoint lists reports.sales_export; the shop endpoint does not', async () => {
  const warehouse = new Client({ name: 'test', version: '0.0.0' })
  await warehouse.connect(new StreamableHTTPClientTransport(new URL(shop.warehouseUrl)))
  try {
    expect(shop.warehouseUrl).toMatch(/\/warehouse\/mcp$/)
    expect((await warehouse.listTools()).tools.map((t) => t.name)).toEqual(['reports.sales_export'])
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('reports.sales_export')
  } finally {
    await warehouse.close()
  }
})

it('reports.sales_export returns a deterministic 1 MB CSV with one note in the middle', async () => {
  const warehouse = new Client({ name: 'test', version: '0.0.0' })
  await warehouse.connect(new StreamableHTTPClientTransport(new URL(shop.warehouseUrl)))
  try {
    const run = async () => ((await warehouse.callTool({ name: 'reports.sales_export', arguments: { month: '2026-09' } })) as { content: { text: string }[] }).content[0]!.text
    const text = await run()
    expect(text.length).toBeGreaterThanOrEqual(1_000_000)
    expect(await run()).toBe(text)
    const rows = text.split('\n')
    const hits = rows.flatMap((r, i) => (r.includes('giao gấp trước Tết') ? [i] : []))
    expect(hits).toHaveLength(1)
    expect(hits[0]!).toBeGreaterThan(rows.length * 0.4)
    expect(hits[0]!).toBeLessThan(rows.length * 0.6)
    expect(rows[0]).toBe('order_id,date,customer_id,sku,size,quantity,amount,status,note')
  } finally {
    await warehouse.close()
  }
})

it('the logistics endpoint lists only shipments.get', async () => {
  const logistics = new Client({ name: 'test', version: '0.0.0' })
  await logistics.connect(new StreamableHTTPClientTransport(new URL(shop.logisticsUrl)))
  try {
    expect(shop.logisticsUrl).toMatch(/\/logistics\/mcp$/)
    expect((await logistics.listTools()).tools.map((t) => t.name)).toEqual(['shipments.get'])
  } finally {
    await logistics.close()
  }
})

it('shipments.get returns a verbose record of at least 2,000 characters; only 2017, 2058 and 2093 are lost', async () => {
  const warehouse = new Client({ name: 'test', version: '0.0.0' })
  await warehouse.connect(new StreamableHTTPClientTransport(new URL(shop.logisticsUrl)))
  try {
    const get = async (id: string) => (await warehouse.callTool({ name: 'shipments.get', arguments: { id } })) as { isError?: boolean; content: { text: string }[] }
    const lost = await get('2058')
    expect(lost.content[0]!.text.length).toBeGreaterThanOrEqual(2_000)
    expect(JSON.parse(lost.content[0]!.text).status).toBe('lost')
    const ok = await get('2001')
    expect(ok.content[0]!.text.length).toBeGreaterThanOrEqual(2_000)
    expect(ok.content[0]!.text.length).toBeLessThan(8_000)
    expect(JSON.parse(ok.content[0]!.text).status).not.toBe('lost')
    expect((await get('2001')).content[0]!.text).toBe(ok.content[0]!.text)
    const statuses = await Promise.all(Array.from({ length: 100 }, async (_, i) => JSON.parse((await get(String(2001 + i))).content[0]!.text).status as string))
    expect(statuses.flatMap((s, i) => (s === 'lost' ? [2001 + i] : []))).toEqual([2017, 2058, 2093])
    const missing = await get('2101')
    expect(missing.isError).toBe(true)
    expect(missing.content[0]!.text).toBe('Shipment not found: 2101')
  } finally {
    await warehouse.close()
  }
})
