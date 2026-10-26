import { parseMasterKey } from '@agent-core/core'

export type ServiceConfig = {
  ok: true
  databaseUrl: string
  migratorUrl: string
  /** From the environment; null means the service generates one at start. */
  adminKey: string | null
  /** From the environment; null means the service reads or creates `master.key` in `dataDir`. */
  masterKey: Buffer | null
  /** Null when `LLM_BASE_URL` or `LLM_MODEL_DEFAULT` is missing: the service starts but cannot run agents. */
  llm: {
    baseUrl: string
    apiKey: string
    /** Alias to real model id. */
    models: Record<string, string>
  } | null
  dataDir: string
  port: number
}

const REQUIRED = ['DATABASE_URL', 'MIGRATOR_DATABASE_URL'] as const

/** Reads and checks the environment. Messages name the variable only, never its value. */
export function readServiceConfig(env: NodeJS.ProcessEnv): ServiceConfig | { ok: false; error: string } {
  const missing = REQUIRED.filter((k) => !env[k])
  if (missing.length > 0) return { ok: false, error: `missing required environment variable(s): ${missing.join(', ')}` }
  const port = Number(env.PORT ?? 7300)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'PORT must be an integer from 1 to 65535' }
  for (const name of ['DATABASE_URL', 'MIGRATOR_DATABASE_URL'] as const) {
    // The URL holds a password: parse inside try/catch and never put the URL or the parser error in the message.
    let username: string
    try {
      username = new URL(env[name]!).username
    } catch {
      return { ok: false, error: `${name} must be a valid postgres URL with a user name` }
    }
    if (name === 'DATABASE_URL' && username === '') return { ok: false, error: `${name} must be a valid postgres URL with a user name` }
  }
  let masterKey: Buffer | null = null
  if (env.AGENT_CORE_MASTER_KEY) {
    try {
      masterKey = parseMasterKey(env.AGENT_CORE_MASTER_KEY)
    } catch {
      return { ok: false, error: 'AGENT_CORE_MASTER_KEY must be 32 bytes encoded in base64' }
    }
  }
  return {
    ok: true,
    databaseUrl: env.DATABASE_URL!,
    migratorUrl: env.MIGRATOR_DATABASE_URL!,
    adminKey: env.AGENT_CORE_ADMIN_KEY || null,
    masterKey,
    llm:
      env.LLM_BASE_URL && env.LLM_MODEL_DEFAULT
        ? {
            baseUrl: env.LLM_BASE_URL,
            apiKey: env.LLM_API_KEY ?? '',
            models: {
              default: env.LLM_MODEL_DEFAULT,
              ...(env.LLM_MODEL_SMART ? { smart: env.LLM_MODEL_SMART } : {}),
            },
          }
        : null,
    dataDir: env.AGENT_CORE_DATA_DIR || './.data',
    port,
  }
}
