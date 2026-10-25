import { createHash } from 'node:crypto'
import type { StoredEvent } from '../types'

export const GENESIS_HASH = '0'.repeat(64)

/** JSON with object keys sorted lexicographically at every depth and no whitespace. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x === undefined ? null : x)).join(',')}]`
  if (v !== null && typeof v === 'object') {
    const obj = v as Record<string, unknown>
    const parts = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    return `{${parts.join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

export function hashEvent(e: Omit<StoredEvent, 'hash'>): string {
  const body = canonicalJson({
    tenantId: e.tenantId,
    runId: e.runId,
    seq: e.seq,
    type: e.type,
    payload: e.payload,
    labels: e.labels,
    agentVersion: e.agentVersion,
    createdAt: e.createdAt,
  })
  return createHash('sha256')
    .update(e.prevHash + body)
    .digest('hex')
}

export function verifyChain(events: StoredEvent[]): { valid: true } | { valid: false; brokenAtSeq: number } {
  let prevHash = GENESIS_HASH
  let expectedSeq = 1
  for (const e of events) {
    const { hash, ...rest } = e
    if (e.seq !== expectedSeq || e.prevHash !== prevHash || hashEvent(rest) !== hash) {
      return { valid: false, brokenAtSeq: e.seq }
    }
    prevHash = hash
    expectedSeq++
  }
  return { valid: true }
}
