import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type pg from 'pg'

const migrationsUrl = new URL('./migrations/', import.meta.url)

/** Runs `fn` in a transaction that holds the migration lock; the lock is released at COMMIT or ROLLBACK. */
async function withMigrationLock(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect()
  let release: Error | undefined
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(727001)')
    await fn(client)
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {}) // must not mask the original error
    release = err instanceof Error ? err : new Error(String(err))
    throw err
  } finally {
    client.release(release)
  }
}

export async function runMigrations(pool: pg.Pool): Promise<void> {
  // The lock comes first: two migrators racing on CREATE TABLE IF NOT EXISTS can still fail.
  await withMigrationLock(pool, async (client) => {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY)')
  })
  const files = (await readdir(fileURLToPath(migrationsUrl))).filter((f) => f.endsWith('.sql')).sort()
  for (const name of files) {
    const sql = await readFile(new URL(name, migrationsUrl), 'utf8')
    await withMigrationLock(pool, async (client) => {
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name])
      if (done.rowCount === 0) {
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name])
      }
    })
  }
}
