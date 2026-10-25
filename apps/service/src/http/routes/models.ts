import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { DEFAULT_MODEL_PROFILE, ModelProfileSchema } from '@agent-core/core'
import type { ModelProfile } from '@agent-core/core'
import type { probeModel } from '@agent-core/llm'
import { ModelProfileRepo } from '@agent-core/store-postgres'
import type { createPool } from '@agent-core/store-postgres'
import { apiError, validationError } from '../errors'

export type ProbeResult = Awaited<ReturnType<typeof probeModel>>

const CheckBody = z.object({ alias: z.string().optional() }).strict()
const ApplyBody = z.object({ apply: z.literal('proposed') }).strict()
/** Picks the shape by the `apply` key, so a wrong body gets errors that name its fields, not a bare union failure. */
const parsePatch = (body: unknown) =>
  typeof body === 'object' && body !== null && 'apply' in body ? ApplyBody.safeParse(body) : ModelProfileSchema.safeParse(body)

export function registerModelRoutes(
  app: FastifyInstance,
  deps: { pool: ReturnType<typeof createPool>; models: Record<string, string>; probe?: (model: string) => Promise<ProbeResult> },
): void {
  const repo = new ModelProfileRepo(deps.pool)
  const modelOf = (alias: string): string => {
    const model = Object.hasOwn(deps.models, alias) ? deps.models[alias] : undefined
    if (model === undefined) {
      throw apiError('unknown_model_alias', `Model alias "${alias}" does not exist.`, 'List the aliases with GET /v1/models.', 404)
    }
    return model
  }
  const view = async (alias: string) => {
    const model = modelOf(alias)
    const row = await repo.get(model)
    return {
      alias,
      model,
      profile: row?.profile ?? null,
      effective: row?.profile ?? DEFAULT_MODEL_PROFILE,
      proposed: row?.proposed ?? null,
      probes: row?.probes ?? null,
      checked_at: row?.checkedAt?.toISOString() ?? null,
    }
  }
  const list = async (aliases: string[]) => ({ models: await Promise.all(aliases.map(view)) })

  app.get('/v1/models', async () => list(Object.keys(deps.models)))

  app.post('/v1/models/check', async (req) => {
    const body = CheckBody.safeParse(req.body ?? {})
    if (!body.success) throw validationError(body.error)
    const { probe } = deps
    if (!probe) {
      throw apiError('model_check_unavailable', 'This service has no model probe configured.', 'Start the service with an LLM endpoint.', 501)
    }
    const aliases = body.data.alias === undefined ? Object.keys(deps.models) : [body.data.alias]
    // Each real model is probed once, all in parallel: two aliases can name the same model.
    const models = [...new Set(aliases.map(modelOf))]
    const results = await Promise.allSettled(
      models.map(async (model) => {
        const result = await probe(model)
        await repo.setProposal(model, result.proposed, result.probes)
      }),
    )
    const failed = models.find((_m, i) => results[i]!.status === 'rejected')
    if (failed !== undefined) {
      const alias = aliases.find((a) => modelOf(a) === failed)!
      // The cause can carry provider text, so the message names the alias only.
      throw apiError('model_check_failed', `The model check failed for alias "${alias}".`, 'Check the LLM endpoint and key, then try again.', 502)
    }
    return list(aliases)
  })

  app.patch<{ Params: { alias: string } }>('/v1/models/:alias', async (req) => {
    const model = modelOf(req.params.alias)
    const body = parsePatch(req.body)
    if (!body.success) throw validationError(body.error)
    let profile: ModelProfile
    if ('apply' in body.data) {
      const row = await repo.get(model)
      if (!row?.proposed) {
        throw apiError('no_proposal', `Alias "${req.params.alias}" has no proposal to apply.`, 'Run POST /v1/models/check first.', 409)
      }
      // A check does not measure prices, so the stored ones stay.
      profile = { ...row.profile, ...row.proposed }
    } else {
      profile = body.data
    }
    await repo.setProfile(model, profile)
    return view(req.params.alias)
  })
}
