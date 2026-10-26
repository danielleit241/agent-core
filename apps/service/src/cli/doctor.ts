import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type pg from 'pg'
import { parseMasterKey } from '@agent-core/core'
import { ADMIN_KEY_SETTING, masterKeyMismatchMessage, readMasterKeyCheck } from '../bootstrap'
import { runReadyChecks } from '../checks'
import type { Check } from '../checks'
import { readServiceConfig } from '../config'

export type DoctorDeps = {
  /** One call to the model; a throw or an HTTP error in any probe fails the check. */
  probe(model: string): Promise<{ probes: { ok: boolean; detail: string }[] }>
  connect(url: string): pg.Pool
}

const ORDER = ['env', 'db', 'migrations', 'runtime_user', 'admin_key', 'master_key', 'llm', 'llm_probe']
const NAME_WIDTH = 12

async function runtimeUserCheck(pool: pg.Pool): Promise<Check> {
  const fix = 'Connect as a login role that is not a superuser and does not bypass row level security.'
  try {
    const { rows } = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    )
    const role = rows[0]
    if (role && !role.rolsuper && !role.rolbypassrls) return { name: 'runtime_user', ok: true }
    return { name: 'runtime_user', ok: false, code: 'runtime_user_privileged', fix }
  } catch {
    return { name: 'runtime_user', ok: false, code: 'runtime_user_unknown', fix: 'Check that the database user can read pg_roles.' }
  }
}

/** Reads the stored admin key hash with the migrator login. It never creates a key. */
async function adminKeyCheck(envKey: string | null, migratorUrl: string, connect: DoctorDeps['connect']): Promise<Check> {
  if (envKey !== null) return { name: 'admin_key', ok: true }
  const pool = connect(migratorUrl)
  try {
    const { rowCount } = await pool.query('SELECT 1 FROM service_settings WHERE name = $1', [ADMIN_KEY_SETTING])
    if (rowCount === 1) return { name: 'admin_key', ok: true }
    return {
      name: 'admin_key',
      ok: true,
      level: 'warn',
      code: 'admin_key_not_generated',
      fix: 'The service generates an admin key at its first start and prints it once. Set AGENT_CORE_ADMIN_KEY to choose your own.',
    }
  } catch {
    return {
      name: 'admin_key',
      ok: true,
      level: 'warn',
      code: 'admin_key_unknown',
      fix: 'Check MIGRATOR_DATABASE_URL and that the service has started once.',
    }
  } finally {
    await pool.end().catch(() => undefined)
  }
}

/** Compares the master key in use with the check value stored by the service. It only reads and never writes the row. */
async function masterKeyMatchCheck(config: { masterKey: Buffer | null; dataDir: string; migratorUrl: string }, connect: DoctorDeps['connect']): Promise<Check | null> {
  let key = config.masterKey
  if (key === null) {
    try {
      key = parseMasterKey(readFileSync(join(config.dataDir, 'master.key'), 'utf8').trim())
    } catch {
      return null // no key file yet: the service creates it at its first start
    }
  }
  const pool = connect(config.migratorUrl)
  try {
    if ((await readMasterKeyCheck(pool, key)) !== 'mismatch') return null
    return { name: 'master_key', ok: false, code: 'master_key_mismatch', fix: masterKeyMismatchMessage(config.dataDir) }
  } catch {
    return null
  } finally {
    await pool.end().catch(() => undefined)
  }
}

async function probeCheck(model: string, probe: DoctorDeps['probe']): Promise<Check> {
  const fix = 'Check LLM_BASE_URL, LLM_API_KEY and LLM_MODEL_DEFAULT.'
  try {
    const result = await probe(model)
    if (result.probes.some((p) => /^HTTP \d+/.test(p.detail))) return { name: 'llm_probe', ok: false, code: 'llm_probe_failed', fix }
    return { name: 'llm_probe', ok: true }
  } catch {
    return { name: 'llm_probe', ok: false, code: 'llm_probe_failed', fix }
  }
}

/** The checks of `agent-core doctor`. It only reads: it never writes the admin key, the master key file or the database. */
export async function runDoctorChecks(env: NodeJS.ProcessEnv, deps: DoctorDeps): Promise<Check[]> {
  const config = readServiceConfig(env)
  if (!config.ok) return [{ name: 'env', ok: false, code: 'env_invalid', fix: `${config.error}.` }]
  const checks: Check[] = [{ name: 'env', ok: true }]
  const pool = deps.connect(config.databaseUrl)
  try {
    const masterKeySource = config.masterKey !== null ? 'env' : 'file'
    const ready = await runReadyChecks({ pool, llmConfigured: config.llm !== null, masterKeySource })
    checks.push(...ready)
    if (ready[0]!.ok) {
      checks.push(await runtimeUserCheck(pool))
      checks.push(await adminKeyCheck(config.adminKey, config.migratorUrl, deps.connect))
      const mismatch = await masterKeyMatchCheck(config, deps.connect)
      if (mismatch) checks.splice(checks.findIndex((c) => c.name === 'master_key'), 1, mismatch)
    }
  } finally {
    await pool.end().catch(() => undefined)
  }
  const llm = checks.find((c) => c.name === 'llm')
  if (llm?.ok && config.llm) checks.push(await probeCheck(config.llm.models.default!, deps.probe))
  return ORDER.flatMap((name) => checks.filter((c) => c.name === name))
}

const status = (c: Check): 'ok' | 'warn' | 'fail' => (!c.ok ? 'fail' : c.level === 'warn' ? 'warn' : 'ok')

/** Prints one line per check and returns the exit code: 1 with any fail, else 0. */
export async function doctor(env: NodeJS.ProcessEnv, io: { out: (line: string) => void }, deps: DoctorDeps): Promise<number> {
  const checks = await runDoctorChecks(env, deps)
  for (const c of checks) io.out(`${status(c).padEnd(4)}  ${c.name.padEnd(NAME_WIDTH)}  ${c.fix ?? ''}`.trimEnd())
  return checks.some((c) => !c.ok) ? 1 : 0
}
