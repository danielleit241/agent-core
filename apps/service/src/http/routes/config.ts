import { randomBytes, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AgentDefinitionSchema, SupportSchema, ToolSafetySchema, resolveSafety, toolFingerprint } from '@agent-core/core'
import type { ToolSafety } from '@agent-core/core'
import { ConfigRepo } from '@agent-core/store-postgres'
import type { LoadedTool, StoredTool, createPool } from '@agent-core/store-postgres'
import type { discoverMcpTools } from '@agent-core/tools-mcp'
import { apiError, validationError } from '../errors'

const TENANT = 'default'
const WEBHOOK_EVENTS = ['run.completed', 'run.failed', 'approval.requested', 'run.waiting_human'] as const

const httpUrl = z.url().refine((u) => /^https?:\/\//i.test(u), { message: 'must be an http(s) URL' })
const ConnectionBody = z.object({ id: z.string().min(1), url: httpUrl })
const WebhookConnectionBody = z.object({
  id: z.string().min(1),
  kind: z.literal('webhook'),
  url: httpUrl,
  tools: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/),
        description: z.string(),
        inputSchema: z.record(z.string(), z.unknown()),
        safety: ToolSafetySchema,
        supports: z.array(SupportSchema).optional(),
      }),
    )
    .min(1)
    .max(100)
    .refine((tools) => new Set(tools.map((t) => t.name)).size === tools.length, { message: 'tool names must be unique' }),
})
const SAFETY_FIELDS = ['effect', 'idempotency', 'reachesOutside', 'outputLabel'] as const
const ConfirmBody = ToolSafetySchema.partial()
  .extend({
    confirm: z.literal('proposed').optional(),
    // The fingerprint the admin reviewed. When it is given and the tool changed since, nothing is confirmed.
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/, { message: 'must be the 64-character fingerprint from GET /v1/connections/{id}/tools' }).optional(),
  })
  .strict()
  .refine((b) => (b.confirm !== undefined) !== SAFETY_FIELDS.some((k) => b[k] !== undefined), {
    message: 'set either "confirm": "proposed" or at least one of effect, idempotency, reachesOutside, outputLabel',
  })
const WebhookBody = z.object({ url: httpUrl, events: z.array(z.enum(WEBHOOK_EVENTS)).min(1) })

type ToolView = {
  name: string
  /** What the model sees of the tool, so an admin can review it before confirming. */
  description: string
  inputSchema: Record<string, unknown>
  safety: ToolSafety
  proposed: ToolSafety
  needsConfirmation: (keyof ToolSafety)[]
  fingerprint: string
  /** True when the definition changed after an admin last reviewed it: the tool runs strict, behind approval, until confirmed again. */
  changedSinceReview: boolean
}

const toView = (t: LoadedTool): ToolView => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
  ...resolveSafety(t.source, t.confirmed),
  fingerprint: t.fingerprint,
  changedSinceReview: t.changedSinceReview,
})

export function registerConfigRoutes(
  app: FastifyInstance,
  deps: { pool: ReturnType<typeof createPool>; discoverTools: typeof discoverMcpTools },
): void {
  const config = new ConfigRepo(deps.pool, TENANT)
  const kindConflict = (id: string, kind: string, wanted: string) =>
    apiError('connection_kind_conflict', `Connection "${id}" exists with kind "${kind}".`, `Use a different id for the ${wanted} connection.`, 409)

  app.post('/v1/connections', async (req, reply) => {
    if ((req.body as { kind?: unknown } | null | undefined)?.kind === 'webhook') {
      const wh = WebhookConnectionBody.safeParse(req.body)
      if (!wh.success) throw validationError(wh.error)
      const { id, url } = wh.data
      // The admin gives the safety at registration, so it counts as confirmed.
      const tools: StoredTool[] = wh.data.tools.map(({ supports, ...tool }) => {
        const source = { declared: tool.safety, ...(supports === undefined ? {} : { supports }) }
        return {
          ...tool,
          connectionId: id,
          ...(supports === undefined ? {} : { supports }),
          safety: resolveSafety(source, tool.safety).safety,
          source,
          confirmed: tool.safety,
          reviewedFor: toolFingerprint({ ...tool, source }),
        }
      })
      let created = false
      const saved = await config.upsertConnection(id, (existing) => {
        if (existing && existing.kind !== 'webhook') throw kindConflict(id, existing.kind, 'webhook')
        created = existing === null
        // Re-registration keeps the secret; a new connection gets one, returned once.
        return { kind: 'webhook', url, secret: existing?.secret ?? randomBytes(32).toString('hex'), tools }
      })
      return reply.code(201).send({ id, kind: 'webhook', tools: saved.tools.map(toView), ...(created ? { secret: saved.secret } : {}) })
    }
    const parsed = ConnectionBody.safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error)
    const { id, url } = parsed.data
    const before = await config.getConnection(id)
    // Checked again under the lock below; this only avoids a discovery that cannot be stored.
    if (before && before.kind !== 'mcp') throw kindConflict(id, before.kind, 'mcp')
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
    const saved = await config.upsertConnection(id, (existing) => {
      if (existing && existing.kind !== 'mcp') throw kindConflict(id, existing.kind, 'mcp')
      // Re-registration keeps the confirmations and the reviewed fingerprint of tools with the same name, so a
      // tool whose definition changed reads back as changed. A new tool is reviewed now: the response shows it.
      const tools: StoredTool[] = found.map(({ tool, source }) => {
        const before = existing?.tools.find((t) => t.name === tool.name)
        const confirmed = before?.confirmed ?? {}
        return {
          ...tool,
          safety: resolveSafety(source, confirmed).safety,
          source,
          confirmed,
          reviewedFor: before?.reviewedFor ?? toolFingerprint({ ...tool, source }),
        }
      })
      return { kind: 'mcp', url, tools }
    })
    return reply.code(201).send({ id, kind: 'mcp', tools: saved.tools.map(toView) })
  })

  const notFound = (id: string) =>
    apiError('connection_not_found', `Connection "${id}" does not exist.`, 'Create the connection with POST /v1/connections first.', 404)

  app.get<{ Params: { id: string } }>('/v1/connections/:id/tools', async (req) => {
    const conn = await config.getConnection(req.params.id)
    if (!conn) throw notFound(req.params.id)
    return { tools: conn.tools.map(toView) }
  })

  app.patch<{ Params: { id: string; tool: string } }>('/v1/connections/:id/tools/:tool', async (req) => {
    const parsed = ConfirmBody.safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error)
    const { confirm, fingerprint, ...values } = parsed.data
    const updated = await config.updateTool(req.params.id, req.params.tool, (tool) => {
      if (fingerprint !== undefined && fingerprint !== tool.fingerprint) {
        throw apiError(
          'tool_changed',
          `Tool "${tool.name}" changed after the fingerprint you sent. Nothing was confirmed.`,
          'Review the tool again with GET /v1/connections/{id}/tools, then confirm it with the new fingerprint.',
          409,
        )
      }
      // `tool.confirmed` holds only a confirmation that matches the current definition.
      const confirmed: Partial<ToolSafety> = confirm === 'proposed' ? resolveSafety(tool.source).proposed : { ...tool.confirmed, ...values }
      return { ...tool, confirmed, reviewedFor: tool.fingerprint, safety: resolveSafety(tool.source, confirmed).safety }
    })
    if (!updated) {
      if (!(await config.getConnection(req.params.id))) throw notFound(req.params.id)
      throw apiError(
        'tool_not_found',
        `Connection "${req.params.id}" has no tool "${req.params.tool}".`,
        'List the tools with GET /v1/connections/{id}/tools.',
        404,
      )
    }
    return toView(updated)
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
