import { randomBytes, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type pg from 'pg'
import { parseMasterKey } from '@agent-core/core'

const ADMIN_KEY_SETTING = 'admin_key_hash'

export const hashAdminKey = (key: string): Buffer => createHash('sha256').update(key).digest()

/**
 * Finds the SHA-256 of the admin key. An env key wins and nothing is stored. Without one, the first start generates a key,
 * stores its hash and prints the key once; later starts read the stored hash. Of several processes starting together on an
 * empty table, only the one whose insert succeeds prints.
 */
export async function ensureAdminKeyHash(
  migrator: pg.Pool,
  envKey: string | null,
  print: (line: string) => void,
): Promise<{ hash: Buffer; source: 'env' | 'generated' | 'stored' }> {
  if (envKey !== null) return { hash: hashAdminKey(envKey), source: 'env' }
  const read = async (): Promise<Buffer | null> => {
    const res = await migrator.query<{ value: Buffer }>('SELECT value FROM service_settings WHERE name = $1', [ADMIN_KEY_SETTING])
    return res.rows[0]?.value ?? null
  }
  const stored = await read()
  if (stored) return { hash: stored, source: 'stored' }
  const key = `ak_admin.${randomBytes(32).toString('base64url')}`
  const hash = hashAdminKey(key)
  const inserted = await migrator.query('INSERT INTO service_settings (name, value) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING name', [
    ADMIN_KEY_SETTING,
    hash,
  ])
  if (inserted.rowCount === 1) {
    print(`agent-core: generated admin key (shown once, store it now): ${key}`)
    return { hash, source: 'generated' }
  }
  const winner = await read()
  if (!winner) throw new Error('the stored admin key hash disappeared during start')
  return { hash: winner, source: 'stored' }
}

/**
 * Finds the master key. An env key wins. Without one, reads `<dataDir>/master.key`; when the file is missing, generates
 * 32 random bytes and writes the file with mode 0600. The warning never contains the key.
 */
export function ensureMasterKey(
  envKey: Buffer | null,
  dataDir: string,
  warn: (line: string) => void,
): { key: Buffer; source: 'env' | 'file' } {
  if (envKey !== null) return { key: envKey, source: 'env' }
  const file = join(dataDir, 'master.key')
  const readFileKey = (): Buffer => {
    try {
      return parseMasterKey(readFileSync(file, 'utf8').trim())
    } catch {
      throw new Error(`the master key file ${file} must hold 32 bytes encoded in base64`)
    }
  }
  if (existsSync(file)) return { key: readFileKey(), source: 'file' }
  mkdirSync(dataDir, { recursive: true })
  const key = randomBytes(32)
  try {
    writeFileSync(file, `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' })
  } catch (err) {
    // Another process wrote the file first: use its key.
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { key: readFileKey(), source: 'file' }
    throw err
  }
  warn(`agent-core: generated a master key in ${file}. Back up this file, or set AGENT_CORE_MASTER_KEY for production.`)
  return { key, source: 'file' }
}
