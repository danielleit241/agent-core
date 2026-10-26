import type pg from 'pg'
import { pendingMigrations } from '@agent-core/store-postgres'

/** One health check. `warn` marks an ok check that deserves attention; `code` is machine readable, `fix` one English sentence. */
export type Check = { name: string; ok: boolean; level?: 'warn'; code?: string; fix?: string }

export type CheckDeps = { pool: pg.Pool; llmConfigured: boolean; masterKeySource: 'env' | 'file' }

async function dbCheck(pool: pg.Pool): Promise<Check> {
  try {
    await pool.query('SELECT 1')
    return { name: 'db', ok: true }
  } catch {
    return { name: 'db', ok: false, code: 'db_unreachable', fix: 'Check DATABASE_URL and that Postgres is running.' }
  }
}

async function migrationsCheck(pool: pg.Pool): Promise<Check> {
  try {
    const pending = await pendingMigrations(pool)
    if (pending.length === 0) return { name: 'migrations', ok: true }
    return { name: 'migrations', ok: false, code: 'migrations_pending', fix: 'Restart the service to apply the pending migrations.' }
  } catch {
    return { name: 'migrations', ok: false, code: 'migrations_unknown', fix: 'Check that the runtime database user can read schema_migrations.' }
  }
}

function llmCheck(configured: boolean): Check {
  if (configured) return { name: 'llm', ok: true }
  return { name: 'llm', ok: false, code: 'llm_not_configured', fix: 'Set LLM_BASE_URL and LLM_MODEL_DEFAULT, then restart.' }
}

function masterKeyCheck(source: 'env' | 'file'): Check {
  if (source === 'env') return { name: 'master_key', ok: true }
  return {
    name: 'master_key',
    ok: true,
    level: 'warn',
    code: 'master_key_generated',
    fix: 'Back up master.key in the data directory, or set AGENT_CORE_MASTER_KEY for production.',
  }
}

/** The checks behind `/readyz`. None of them calls an LLM. */
export async function runReadyChecks(deps: CheckDeps): Promise<Check[]> {
  const db = await dbCheck(deps.pool)
  // Without a database the migration list cannot be read.
  if (!db.ok) return [db]
  return [db, await migrationsCheck(deps.pool), llmCheck(deps.llmConfigured), masterKeyCheck(deps.masterKeySource)]
}
