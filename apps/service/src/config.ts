import { parseMasterKey } from '@agent-core/core'

export type ServiceConfig = {
  ok: true
  databaseUrl: string
  migratorUrl: string
  adminKey: string
  masterKey: Buffer
  llmBaseUrl: string
  llmApiKey: string
  /** Alias to real model id. */
  models: Record<string, string>
  port: number
}

const REQUIRED = [
  'DATABASE_URL',
  'MIGRATOR_DATABASE_URL',
  'AGENT_CORE_ADMIN_KEY',
  'AGENT_CORE_MASTER_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL_DEFAULT',
] as const

/** Reads and checks the environment. Messages name the variable only, never its value. */
export function readServiceConfig(env: NodeJS.ProcessEnv): ServiceConfig | { ok: false; error: string } {
  const missing = REQUIRED.filter((k) => !env[k])
  if (missing.length > 0) return { ok: false, error: `missing required environment variable(s): ${missing.join(', ')}` }
  const port = Number(env.PORT ?? 7300)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'PORT must be an integer from 1 to 65535' }
  let masterKey: Buffer
  try {
    masterKey = parseMasterKey(env.AGENT_CORE_MASTER_KEY!)
  } catch {
    return { ok: false, error: 'AGENT_CORE_MASTER_KEY must be 32 bytes encoded in base64' }
  }
  return {
    ok: true,
    databaseUrl: env.DATABASE_URL!,
    migratorUrl: env.MIGRATOR_DATABASE_URL!,
    adminKey: env.AGENT_CORE_ADMIN_KEY!,
    masterKey,
    llmBaseUrl: env.LLM_BASE_URL!,
    llmApiKey: env.LLM_API_KEY ?? '',
    models: {
      default: env.LLM_MODEL_DEFAULT!,
      ...(env.LLM_MODEL_SMART ? { smart: env.LLM_MODEL_SMART } : {}),
    },
    port,
  }
}
