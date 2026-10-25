import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SupportSchema, ToolSafetySchema, resolveSafety } from '@agent-core/core'
import type { SafetySource, Support, ToolDescriptor, ToolInvoker } from '@agent-core/core'

export class ToolInvocationError extends Error {
  constructor(
    message: string,
    readonly code: 'connection_unreachable' | 'connection_unavailable' | 'tool_call_failed',
    /** true when the request was never sent, so the call is safe to retry. */
    readonly notSent: boolean,
  ) {
    super(message)
    this.name = 'ToolInvocationError'
  }
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** The URL without credentials and query, for server-side logs. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    u.username = ''
    u.password = ''
    u.search = ''
    return u.toString()
  } catch {
    return '<invalid url>'
  }
}

// Errors name the connection, never the URL: URLs may carry credentials, and errors reach events and the LLM.
async function connect(connectionId: string, url: string): Promise<Client> {
  const client = new Client({ name: 'agent-core', version: '0.0.0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  } catch (cause) {
    await client.close().catch(() => undefined)
    const safeUrl = redactUrl(url)
    console.error(`mcp: connect to ${connectionId} (${safeUrl}) failed: ${reason(cause).replaceAll(url, safeUrl)}`)
    throw new ToolInvocationError(`connection_unreachable: ${connectionId}`, 'connection_unreachable', true)
  }
  return client
}

const DeclaredSafetySchema = ToolSafetySchema.partial().strict()
const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const

/** What the tool says about itself: annotations plus the `agent-core/*` `_meta` declarations. All of it is a proposal. */
function readSource(connectionId: string, t: { name: string; annotations?: object; _meta?: Record<string, unknown> }): SafetySource {
  const source: SafetySource = {}
  const annotations: Record<string, boolean> = {}
  for (const h of HINTS) {
    const v = (t.annotations as Record<string, unknown> | undefined)?.[h]
    if (typeof v === 'boolean') annotations[h] = v
  }
  if (Object.keys(annotations).length > 0) source.annotations = annotations
  const rawSafety = t._meta?.['agent-core/safety']
  if (rawSafety !== undefined) {
    const declared = DeclaredSafetySchema.safeParse(rawSafety)
    if (declared.success) source.declared = declared.data
    else console.error(`mcp: ignored invalid agent-core/safety on tool ${t.name} of ${connectionId}`)
  }
  const rawSupports = t._meta?.['agent-core/supports']
  if (Array.isArray(rawSupports)) {
    source.supports = rawSupports.flatMap((v): Support[] => {
      const s = SupportSchema.safeParse(v)
      return s.success ? [s.data] : []
    })
  }
  return source
}

export async function discoverMcpTools(
  connectionId: string,
  url: string,
): Promise<{ tool: ToolDescriptor; source: SafetySource }[]> {
  let client: Client
  try {
    client = await connect(connectionId, url)
  } catch (err) {
    throw new Error(reason(err))
  }
  try {
    const found: { tool: ToolDescriptor; source: SafetySource }[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined)
      for (const t of page.tools) {
        const source = readSource(connectionId, t)
        found.push({
          tool: {
            name: t.name,
            description: t.description ?? '',
            inputSchema: t.inputSchema as Record<string, unknown>,
            safety: resolveSafety(source).safety,
            connectionId,
            ...(source.supports && { supports: source.supports }),
          },
          source,
        })
      }
      cursor = page.nextCursor
    } while (cursor)
    return found
  } finally {
    await client.close()
  }
}

export function createMcpInvoker(
  resolveUrl: (connectionId: string) => Promise<string>,
): ToolInvoker & { close(): Promise<void> } {
  type Entry = { url: string; pending: Promise<Client> }
  const clients = new Map<string, Entry>()

  async function getEntry(connectionId: string): Promise<Entry> {
    let url: string
    try {
      url = await resolveUrl(connectionId)
    } catch {
      // The cause may carry credentials, so only the connection id is reported.
      throw new ToolInvocationError(`connection_unavailable: ${connectionId}`, 'connection_unavailable', true)
    }
    const cached = clients.get(connectionId)
    if (cached?.url === url) return cached
    if (cached) await drop(connectionId, cached) // the URL changed: close the stale client
    const entry: Entry = { url, pending: connect(connectionId, url) }
    clients.set(connectionId, entry)
    entry.pending.catch(() => {
      if (clients.get(connectionId) === entry) clients.delete(connectionId)
    })
    return entry
  }

  /** Removes only the given client instance, so a newer client for the same connection survives. */
  async function drop(connectionId: string, entry: Entry): Promise<void> {
    if (clients.get(connectionId) === entry) clients.delete(connectionId)
    const client = await entry.pending.catch(() => undefined)
    await client?.close().catch(() => undefined)
  }

  async function attempt(tool: ToolDescriptor, args: Record<string, unknown>, idempotencyKey: string) {
    const entry = await getEntry(tool.connectionId)
    const client = await entry.pending // a connect failure is a ToolInvocationError with notSent = true
    try {
      return await client.callTool({
        name: tool.name,
        arguments: args,
        _meta: { 'agent-core/idempotency-key': idempotencyKey },
      })
    } catch (err) {
      await drop(tool.connectionId, entry)
      throw new ToolInvocationError(`tool_call_failed: ${tool.name}: ${reason(err)}`, 'tool_call_failed', false)
    }
  }

  return {
    async call(tool, args, ctx) {
      // No dry-run protocol in M0: a write cannot be simulated, a read is harmless to run.
      if (ctx.dryRun && tool.safety.effect === 'write') throw new Error(`dry_run_not_supported: ${tool.name}`)
      // One attempt only: the runner owns retries.
      const result = await attempt(tool, args, ctx.idempotencyKey)
      const parts = Array.isArray(result.content) ? result.content : []
      const content = parts
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n')
      return { content, isError: result.isError === true }
    },
    async close() {
      const entries = [...clients.entries()]
      await Promise.all(entries.map(([id, entry]) => drop(id, entry)))
    },
  }
}
