import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export type FakeTurn = {
  content?: string
  toolCalls?: { name: string; arguments: string | Record<string, unknown> }[]
  status?: number
  finishReason?: string
  usage?: { prompt_tokens: number; completion_tokens: number; cost?: number }
}

// Same rule as the real adapter, kept local so this mock stays free of our packages.
function toWireName(name: string): string {
  const safe = name.replaceAll('.', '__').replace(/[^a-zA-Z0-9_-]/g, '_')
  if (safe.length <= 64) return safe
  return `${safe.slice(0, 55)}_${createHash('sha256').update(name).digest('hex').slice(0, 8)}`
}

export async function startFakeLlm(
  script: FakeTurn[],
): Promise<{ url: string; requests: unknown[]; close(): Promise<void> }> {
  const requests: unknown[] = []
  let turnIndex = 0
  let callCounter = 0

  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        send(404, { error: { message: 'not found' } })
        return
      }
      try {
        requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        send(400, { error: { message: 'invalid JSON body' } })
        return
      }
      const turn = script[turnIndex++]
      if (!turn) {
        send(500, { error: { message: 'script exhausted' } })
        return
      }
      const status = turn.status ?? 200
      if (status !== 200) {
        send(status, { error: { message: `scripted error ${status}` } })
        return
      }
      const toolCalls = (turn.toolCalls ?? []).map((tc) => ({
        id: `call_${++callCounter}`,
        type: 'function',
        function: {
          name: toWireName(tc.name),
          arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
        },
      }))
      const hasCalls = toolCalls.length > 0
      send(200, {
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: turn.content ?? (hasCalls ? null : ''),
              ...(hasCalls ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: turn.finishReason ?? (hasCalls ? 'tool_calls' : 'stop'),
          },
        ],
        usage: turn.usage ?? { prompt_tokens: 10, completion_tokens: 5 },
      })
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
        server.closeAllConnections()
      }),
  }
}
