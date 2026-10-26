import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type pg from 'pg'
import { parseMasterKey } from '@agent-core/core'

export const ADMIN_KEY_SETTING = 'admin_key_hash'
export const MASTER_KEY_CHECK_SETTING = 'master_key_check'

export const hashAdminKey = (key: string): Buffer => createHash('sha256').update(key).digest()

/**
 * Finds the SHA-256 of the admin key. An env key wins and the stored generated hash is deleted, so unsetting the env key later
 * generates a fresh key instead of reviving the old one. Without an env key, the first start generates a key,
 * stores its hash and prints the key once; later starts read the stored hash. Of several processes starting together on an
 * empty table, only the one whose insert succeeds prints.
 */
export async function ensureAdminKeyHash(
  migrator: pg.Pool,
  envKey: string | null,
  print: (line: string) => void,
): Promise<{ hash: Buffer; source: 'env' | 'generated' | 'stored' }> {
  if (envKey !== null) {
    await migrator.query('DELETE FROM service_settings WHERE name = $1', [ADMIN_KEY_SETTING])
    return { hash: hashAdminKey(envKey), source: 'env' }
  }
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

/** HMAC-SHA256 of a constant under the master key. It proves which key encrypted the data and reveals nothing about the key. */
export const masterKeyCheckValue = (key: Buffer): Buffer => createHmac('sha256', key).update('agent-core master key check v1').digest()

/** Reads the stored check value: `none` when no row exists. It never writes. */
export async function readMasterKeyCheck(migrator: pg.Pool, key: Buffer): Promise<'match' | 'mismatch' | 'none'> {
  const res = await migrator.query<{ value: Buffer }>('SELECT value FROM service_settings WHERE name = $1', [MASTER_KEY_CHECK_SETTING])
  const stored = res.rows[0]?.value
  if (!stored) return 'none'
  const expected = masterKeyCheckValue(key)
  return stored.length === expected.length && timingSafeEqual(stored, expected) ? 'match' : 'mismatch'
}

export const masterKeyMismatchMessage = (dataDir: string): string =>
  `the master key differs from the one the data was encrypted with. Restore the original AGENT_CORE_MASTER_KEY or ${join(dataDir, 'master.key')}.`

/**
 * Refuses a master key that differs from the one the stored data used. The first start stores the check value; concurrent
 * starts agree because the insert is `ON CONFLICT DO NOTHING` and the row is read again.
 */
export async function ensureMasterKeyCheck(migrator: pg.Pool, key: Buffer, dataDir: string): Promise<void> {
  if ((await readMasterKeyCheck(migrator, key)) === 'none') {
    await migrator.query('INSERT INTO service_settings (name, value) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      MASTER_KEY_CHECK_SETTING,
      masterKeyCheckValue(key),
    ])
  }
  if ((await readMasterKeyCheck(migrator, key)) !== 'match') throw new Error(masterKeyMismatchMessage(dataDir))
}
