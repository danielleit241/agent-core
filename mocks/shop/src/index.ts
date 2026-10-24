import { createServer } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

type Order = { status: string; amount: number; customerId: string }

const DEFAULT_ORDERS: Record<string, Order> = {
  '1042': { status: 'delivered', amount: 1200000, customerId: 'cus_2291' },
  '1050': { status: 'delivered', amount: 500000, customerId: 'cus_2291' },
}

export async function startShop(
  seed?: { orders: Record<string, Order> },
  port = 0,
): Promise<{
  url: string
  state: { refunds: { orderId: string; amount: number }[]; initializeCount: number }
  /** One-shot: the next tool call executes, then its socket is destroyed before the response. */
  failNextResponseAfterExecute(): void
  close(): Promise<void>
}> {
  const orders = seed?.orders ?? DEFAULT_ORDERS
  const state = { refunds: [] as { orderId: string; amount: number }[], initializeCount: 0 }
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
    return server
  }

  const http = createServer((req, res) => {
    if (req.url !== '/mcp' || req.method !== 'POST') {
      res.writeHead(req.url === '/mcp' ? 405 : 404).end()
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
      if ((body as { method?: unknown } | null)?.method === 'initialize') state.initializeCount++
      const server = buildServer(req.socket)
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
    state,
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
