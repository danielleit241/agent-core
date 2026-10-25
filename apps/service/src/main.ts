import { hostname } from 'node:os'
import { DEFAULT_MODEL_PROFILE } from '@agent-core/core'
import { createOpenAICompatible, probeModel } from '@agent-core/llm-openai'
import { ModelProfileRepo, createPool, runMigrations } from '@agent-core/store-postgres'
import { createServiceStack } from './stack'

async function main(): Promise<void> {
  const env = process.env
  const missing = ['DATABASE_URL', 'AGENT_CORE_ADMIN_KEY', 'LLM_BASE_URL', 'LLM_MODEL_DEFAULT'].filter((k) => !env[k])
  if (missing.length > 0) {
    console.error(`agent-core: missing required environment variable(s): ${missing.join(', ')}`)
    process.exit(1)
  }
  const port = Number(env.PORT ?? 7300)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('agent-core: PORT must be an integer from 1 to 65535')
    process.exit(1)
  }
  const pool = createPool(env.DATABASE_URL!)
  await runMigrations(pool)

  const baseUrl = env.LLM_BASE_URL!
  const apiKey = env.LLM_API_KEY ?? ''
  const models: Record<string, string> = {
    default: env.LLM_MODEL_DEFAULT!,
    ...(env.LLM_MODEL_SMART ? { smart: env.LLM_MODEL_SMART } : {}),
  }
  const profiles = new ModelProfileRepo(pool)
  const llm = createOpenAICompatible({
    baseUrl,
    apiKey,
    models,
    profile: async (model) => {
      try {
        return (await profiles.get(model))?.profile ?? DEFAULT_MODEL_PROFILE
      } catch (err) {
        console.error(`agent-core: could not read the model profile, using the default profile (${err instanceof Error ? err.name : 'error'})`)
        return DEFAULT_MODEL_PROFILE
      }
    },
  })
  const stack = createServiceStack({
    pool,
    adminKey: env.AGENT_CORE_ADMIN_KEY!,
    llm,
    models,
    probe: (model) => probeModel({ baseUrl, apiKey, model }),
    workerId: `${hostname()}:${process.pid}`,
  })
  const { app } = stack
  await app.listen({ host: '0.0.0.0', port })
  console.log(`agent-core: listening on port ${port}`)

  let stopping = false
  const shutdown = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    await stack.close()
    await pool.end()
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      shutdown().then(
        () => process.exit(0),
        (err: unknown) => {
          console.error('agent-core: shutdown failed', err)
          process.exit(1)
        },
      )
    })
  }
}

main().catch((err: unknown) => {
  console.error('agent-core: failed to start', err)
  process.exit(1)
})
