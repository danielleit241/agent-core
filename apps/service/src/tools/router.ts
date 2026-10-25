import type { ToolInvoker } from '@agent-core/core'
import type { ConfigRepo } from '@agent-core/store-postgres'
import { createMcpInvoker, createWebhookInvoker, ToolInvocationError } from '@agent-core/tools'

/** Sends each call to the MCP or the webhook invoker, by the kind of the tool's connection. */
export function createToolRouter(config: ConfigRepo): ToolInvoker & { close(): Promise<void> } {
  const mcp = createMcpInvoker(async (id) => {
    const connection = await config.getConnection(id)
    if (connection?.kind !== 'mcp') throw new Error(`connection not found: ${id}`)
    return connection.url
  })
  const webhook = createWebhookInvoker(async (id) => {
    const connection = await config.getConnection(id)
    if (connection?.kind !== 'webhook' || connection.secret === null) throw new Error(`connection not found: ${id}`)
    return { url: connection.url, secret: connection.secret }
  })
  // The API never changes the kind of an existing connection (409), so a known kind is kept. Misses are not.
  const kinds = new Map<string, 'mcp' | 'webhook'>()
  return {
    async call(tool, args, ctx) {
      let kind = kinds.get(tool.connectionId)
      if (kind === undefined) {
        try {
          kind = (await config.getConnection(tool.connectionId))?.kind
        } catch {
          // The cause may carry credentials, so only the connection id is reported.
          kind = undefined
        }
        if (kind !== undefined) kinds.set(tool.connectionId, kind)
      }
      if (kind === 'webhook') return webhook.call(tool, args, ctx)
      if (kind === 'mcp') return mcp.call(tool, args, ctx)
      throw new ToolInvocationError(`connection_unavailable: ${tool.connectionId}`, 'connection_unavailable', true)
    },
    close: () => mcp.close(),
  }
}
