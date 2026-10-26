import { hostname } from 'node:os'
import { DEFAULT_MODEL_PROFILE, createSecretBox } from '@agent-core/core'
import { createOpenAICompatible, probeModel } from '@agent-core/llm'
import { ModelProfileRepo, createPool, runMigrations, runtimeUserOf } from '@agent-core/store-postgres'
import { ensureAdminKeyHash, ensureMasterKey, ensureMasterKeyCheck } from './bootstrap'
import { readServiceConfig } from './config'
import { createServiceStack } from './stack'

async function main(): Promise<void> {
  const config = readServiceConfig(process.env)
  if (!config.ok) {
    console.error(`agent-core: ${config.error}`)
    process.exit(1)
  }
  const { port, llm: llmConfig } = config
  const migrator = createPool(config.migratorUrl)
  let adminKeyHash: Buffer
  let master: ReturnType<typeof ensureMasterKey>
  try {
    await runMigrations(migrator, { runtimeUser: runtimeUserOf(config.databaseUrl) })
    adminKeyHash = (await ensureAdminKeyHash(migrator, config.adminKey, console.log)).hash
    master = ensureMasterKey(config.masterKey, config.dataDir, console.warn)
    await ensureMasterKeyCheck(migrator, master.key, config.dataDir)
  } finally {
    await migrator.end()
  }
  const pool = createPool(config.databaseUrl)

  const profiles = new ModelProfileRepo(pool)
  const llm = llmConfig
    ? createOpenAICompatible({
        baseUrl: llmConfig.baseUrl,
        apiKey: llmConfig.apiKey,
        models: llmConfig.models,
        profile: async (model) => {
          try {
            return (await profiles.get(model))?.profile ?? DEFAULT_MODEL_PROFILE
          } catch (err) {
            console.error(`agent-core: could not read the model profile, using the default profile (${err instanceof Error ? err.name : 'error'})`)
            return DEFAULT_MODEL_PROFILE
          }
        },
      })
    : null
  if (llm === null) console.warn('agent-core: LLM_BASE_URL or LLM_MODEL_DEFAULT is not set; runs are refused and queued runs are not processed until both are set and the service restarts.')
  const stack = createServiceStack({
    pool,
    adminKeyHash,
    secrets: createSecretBox(master.key),
    masterKeySource: master.source,
    llm,
    models: llmConfig?.models,
    probe: llmConfig ? (model) => probeModel({ baseUrl: llmConfig.baseUrl, apiKey: llmConfig.apiKey, model }) : undefined,
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
