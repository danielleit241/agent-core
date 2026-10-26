import { createServer } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

type Order = { status: string; amount: number; customerId: string; sku?: string; size?: string }
type ShopSeed = { orders: Record<string, Order>; inventory?: Record<string, number> } // inventory key: `${sku}:${size}`
type SizeChange = { orderId: string; from?: string; to: string }

const DEFAULT_SEED: ShopSeed = {
  orders: {
    '1042': { status: 'delivered', amount: 1200000, customerId: 'cus_2291', sku: 'tee-basic', size: 'M' },
    '1050': { status: 'delivered', amount: 500000, customerId: 'cus_2291', sku: 'tee-basic', size: 'M' },
  },
  inventory: { 'tee-basic:S': 0, 'tee-basic:M': 3, 'tee-basic:L': 2 },
}

const SALES_ROWS = 10_000
/** The row of the export that carries the unique note, in the middle. */
const NOTE_ROW = SALES_ROWS / 2
const UNIQUE_NOTE = 'giao gấp trước Tết'
const FILLER_NOTES = [
  'khách dặn gọi điện trước khi giao hàng tại địa chỉ số 12 ngõ 34 đường Láng',
  'giao giờ hành chính nhờ bảo vệ tòa nhà nhận hộ khi khách không có nhà',
  'đóng gói thêm một lớp xốp chống sốc theo yêu cầu của khách hàng thân thiết',
  'không cần xuất hóa đơn đỏ khách đã nhận hóa đơn điện tử qua thư điện tử',
  'khách đổi địa chỉ nhận hàng sang văn phòng tầng 5 tòa nhà phía sau chợ lớn',
  'đơn từ chương trình khuyến mãi cuối tuần đã áp dụng mã giảm giá của cửa hàng',
  'hàng dễ vỡ xin nhẹ tay khi vận chuyển và giao đúng hẹn cho khách hàng nhé',
]

/** A deterministic sales report for a month: about 10,000 rows (over 1 MB), one of them in the middle with a unique note. */
function salesExport(month: string): string {
  const sizes = ['S', 'M', 'L', 'XL']
  const statuses = ['delivered', 'shipped', 'processing', 'returned']
  const rows = ['order_id,date,customer_id,sku,size,quantity,amount,status,note']
  for (let i = 0; i < SALES_ROWS; i++) {
    const day = String((i % 28) + 1).padStart(2, '0')
    const customer = String((i * 7919) % 9000 + 1000)
    const quantity = (i % 3) + 1
    const note = i === NOTE_ROW ? UNIQUE_NOTE : `${FILLER_NOTES[i % FILLER_NOTES.length]!} (mã ${i * 31 % 997})`
    rows.push(
      [20000 + i, `${month}-${day}`, `cus_${customer}`, `tee-basic-${i % 5}`, sizes[i % 4], quantity, quantity * (250_000 + (i % 4) * 50_000), statuses[i % 4], note].join(','),
    )
  }
  return rows.join('\n')
}

export async function startShop(
  seed?: ShopSeed,
  port = 0,
): Promise<{
  url: string
  /** A second MCP endpoint with the warehouse tools. */
  warehouseUrl: string
  state: { refunds: { orderId: string; amount: number }[]; sizeChanges: SizeChange[]; initializeCount: number }
  /** Replaces orders and inventory with a deep copy of the seed (default seed when omitted); clears refunds and size changes. */
  reset(seed?: ShopSeed): void
  snapshot(): {
    orders: Record<string, Order>
    inventory: Record<string, number>
    refunds: { orderId: string; amount: number }[]
    sizeChanges: SizeChange[]
  }
  /** One-shot: the next tool call executes, then its socket is destroyed before the response. */
  failNextResponseAfterExecute(): void
  close(): Promise<void>
}> {
  let orders: Record<string, Order> = {}
  let inventory: Record<string, number> = {}
  const state = {
    refunds: [] as { orderId: string; amount: number }[],
    sizeChanges: [] as SizeChange[],
    initializeCount: 0,
  }
  const reset = (next: ShopSeed = DEFAULT_SEED) => {
    const copy = structuredClone(next)
    orders = copy.orders
    inventory = copy.inventory ?? {}
    state.refunds.length = 0
    state.sizeChanges.length = 0
  }
  reset(seed)
  let crashNext = false
  const crashIfArmed = (socket: Socket) => {
    if (!crashNext) return
    crashNext = false
    socket.destroy()
  }

  function buildServer(socket: Socket): McpServer {
    const server = new McpServer({ name: 'mock-shop', version: '0.0.0' })
    server.registerTool(
      'orders.get',
      {
        description: 'Look up an order by id: status, amount, customer.',
        inputSchema: { order_id: z.string() },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ order_id }) => {
        const order = orders[order_id]
        if (!order) return { isError: true, content: [{ type: 'text', text: `Order not found: ${order_id}` }] }
        crashIfArmed(socket)
        return { content: [{ type: 'text', text: JSON.stringify(order) }] }
      },
    )
    server.registerTool(
      'payments.refund',
      {
        description: 'Refund an amount for an order to the customer.',
        inputSchema: { order_id: z.string(), amount: z.number() },
        annotations: { destructiveHint: true, openWorldHint: false },
      },
      async ({ order_id, amount }) => {
        if (!orders[order_id]) return { isError: true, content: [{ type: 'text', text: `Order not found: ${order_id}` }] }
        state.refunds.push({ orderId: order_id, amount })
        crashIfArmed(socket)
        return { content: [{ type: 'text', text: `Refunded ${amount} for order ${order_id}` }] }
      },
    )
    server.registerTool(
      'inventory.check',
      {
        description: 'Check the stock quantity of a product size.',
        inputSchema: { sku: z.string(), size: z.string() },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ sku, size }) => {
        const quantity = inventory[`${sku}:${size}`] ?? 0
        return { content: [{ type: 'text', text: JSON.stringify({ sku, size, quantity }) }] }
      },
    )
    server.registerTool(
      'orders.change_size',
      {
        description: 'Change the size of an order to another size that is in stock.',
        inputSchema: { order_id: z.string(), size: z.string() },
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      async ({ order_id, size }) => {
        const order = orders[order_id]
        if (!order) return { isError: true, content: [{ type: 'text', text: `Order not found: ${order_id}` }] }
        if (order.sku === undefined) {
          return { isError: true, content: [{ type: 'text', text: `Order ${order_id} has no size to change` }] }
        }
        if (order.size === size) {
          return { isError: true, content: [{ type: 'text', text: `Order ${order_id} is already size ${size}` }] }
        }
        const key = `${order.sku}:${size}`
        if ((inventory[key] ?? 0) <= 0) {
          return { isError: true, content: [{ type: 'text', text: `Out of stock: ${order.sku} size ${size}` }] }
        }
        inventory[key]! -= 1
        if (order.size !== undefined) {
          const oldKey = `${order.sku}:${order.size}`
          inventory[oldKey] = (inventory[oldKey] ?? 0) + 1
        }
        state.sizeChanges.push({ orderId: order_id, ...(order.size !== undefined && { from: order.size }), to: size })
        order.size = size
        return { content: [{ type: 'text', text: `Changed order ${order_id} to size ${size}` }] }
      },
    )
    return server
  }

  function buildWarehouse(): McpServer {
    const server = new McpServer({ name: 'mock-warehouse', version: '0.0.0' })
    server.registerTool(
      'reports.sales_export',
      {
        description: 'Export the sales of a month as CSV: one row per order with date, customer, product, amount, status and note.',
        inputSchema: { month: z.string().regex(/^\d{4}-\d{2}$/) },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ month }) => ({ content: [{ type: 'text', text: salesExport(month) }] }),
    )
    return server
  }

  const http = createServer((req, res) => {
    const path = req.url
    if ((path !== '/mcp' && path !== '/warehouse/mcp') || req.method !== 'POST') {
      res.writeHead(path === '/mcp' || path === '/warehouse/mcp' ? 405 : 404).end()
      return
    }
    // Stateless mode: a fresh server and transport per request.
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      let body: unknown
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400).end()
        return
      }
      if ((body as { method?: unknown } | null)?.method === 'initialize' && path === '/mcp') state.initializeCount++
      const server = path === '/mcp' ? buildServer(req.socket) : buildWarehouse()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      server
        .connect(transport)
        .then(() => transport.handleRequest(req, res, body))
        .catch(() => {
          if (!res.headersSent) res.writeHead(500)
          res.end()
        })
    })
  })
  await new Promise<void>((resolve) => http.listen(port, '127.0.0.1', resolve))
  const { port: boundPort } = http.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${boundPort}/mcp`,
    warehouseUrl: `http://127.0.0.1:${boundPort}/warehouse/mcp`,
    state,
    reset,
    snapshot: () =>
      structuredClone({ orders, inventory, refunds: state.refunds, sizeChanges: state.sizeChanges }),
    failNextResponseAfterExecute() {
      crashNext = true
    },
    close: () =>
      new Promise<void>((resolve) => {
        http.close(() => resolve())
        http.closeAllConnections()
      }),
  }
}
