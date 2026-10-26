import type { SecretBox, ToolInvoker } from '@agent-core/core'
import { ConfigRepo } from '@agent-core/store-postgres'
import type { createPool } from '@agent-core/store-postgres'
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

/** One tool router per tenant, so a connection id of one tenant never resolves to another tenant's URL or cache. */
export function createToolRouters(
  pool: ReturnType<typeof createPool>,
  secrets: SecretBox,
): { forTenant(tenantId: string): ToolInvoker; close(): Promise<void> } {
  const routers = new Map<string, ReturnType<typeof createToolRouter>>()
  return {
    forTenant(tenantId) {
      let router = routers.get(tenantId)
      if (!router) {
        router = createToolRouter(new ConfigRepo(pool, tenantId, secrets))
        routers.set(tenantId, router)
      }
      return router
    },
    async close() {
      await Promise.all([...routers.values()].map((r) => r.close()))
    },
  }
}
