import { randomBytes, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AgentDefinitionSchema } from '@agent-core/core'
import { ConfigRepo } from '@agent-core/store-postgres'
import type { createPool } from '@agent-core/store-postgres'
import type { discoverMcpTools } from '@agent-core/tools-mcp'
import { apiError, validationError } from '../errors'

const TENANT = 'default'
const WEBHOOK_EVENTS = ['run.completed', 'run.failed', 'approval.requested'] as const

const httpUrl = z.url().refine((u) => /^https?:\/\//i.test(u), { message: 'must be an http(s) URL' })
const ConnectionBody = z.object({ id: z.string().min(1), url: httpUrl })
const WebhookBody = z.object({ url: httpUrl, events: z.array(z.enum(WEBHOOK_EVENTS)).min(1) })

export function registerConfigRoutes(
  app: FastifyInstance,
  deps: { pool: ReturnType<typeof createPool>; discoverTools: typeof discoverMcpTools },
): void {
  const config = new ConfigRepo(deps.pool, TENANT)

  app.post('/v1/connections', async (req, reply) => {
    const parsed = ConnectionBody.safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error)
    const { id, url } = parsed.data
    let found: Awaited<ReturnType<typeof discoverMcpTools>>
    try {
      found = await deps.discoverTools(id, url)
    } catch {
      throw apiError(
        'connection_unreachable',
        'Could not connect to the MCP server at the given URL.',
        'Check that the MCP server is running and that the URL is correct.',
        422,
      )
    }
    await config.putConnection({ id, url, tools: found.map((f) => f.tool) })
    return reply.code(201).send({
      id,
      kind: 'mcp',
      tools: found.map((f) => ({ name: f.tool.name, safety: f.tool.safety, needsConfirmation: f.needsConfirmation })),
    })
  })

  app.post('/v1/agents', async (req, reply) => {
    const autonomy = (req.body as { autonomy?: unknown } | null | undefined)?.autonomy
    if (autonomy !== undefined && autonomy !== 'supervised') {
      throw apiError(
        'autonomy_not_supported',
        'Only the "supervised" autonomy level is supported.',
        'Set "autonomy" to "supervised".',
        400,
      )
    }
    const parsed = AgentDefinitionSchema.safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error)
    for (const connectionId of parsed.data.connections) {
      if (!(await config.getConnection(connectionId))) {
        throw apiError(
          'unknown_connection',
          `Connection "${connectionId}" does not exist.`,
          'Create the connection with POST /v1/connections first.',
          422,
        )
      }
    }
    const { id, version } = await config.putAgent(parsed.data)
    return reply.code(201).send({ id, version })
  })

  app.post('/v1/webhooks', async (req, reply) => {
    const parsed = WebhookBody.safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error)
    const id = `wh_${randomUUID()}`
    const secret = randomBytes(32).toString('hex')
    await config.putWebhook({ id, url: parsed.data.url, secret, events: [...new Set(parsed.data.events)] })
    return reply.code(201).send({ id, secret })
  })
}
