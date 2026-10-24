import { createHash } from 'node:crypto'

const MAX_LEN = 64

/** Map an internal tool name to a name matching `^[a-zA-Z0-9_-]{1,64}$`. Deterministic, not reversible. */
export function toWireName(name: string): string {
  const safe = name.replaceAll('.', '__').replace(/[^a-zA-Z0-9_-]/g, '_')
  if (safe.length <= MAX_LEN) return safe
  return `${safe.slice(0, 55)}_${createHash('sha256').update(name).digest('hex').slice(0, 8)}`
}

/** Best-effort inverse for names not found in a per-request map. */
export const fromWireName = (wire: string): string => wire.replaceAll('__', '.')
