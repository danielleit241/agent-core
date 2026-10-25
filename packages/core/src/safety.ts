import { createHash } from 'node:crypto'
import { canonicalJson } from './hash'
import type { Support, ToolSafety } from './types'

export const STRICT_SAFETY: ToolSafety = { effect: 'write', idempotency: false, reachesOutside: true, outputLabel: 'untrusted' }

export type McpAnnotations = {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export type SafetySource = { annotations?: McpAnnotations; declared?: Partial<ToolSafety>; supports?: Support[] }

/** What the tool says about itself. A proposal only: it needs a confirmation before it loosens anything. */
export function proposeSafety(src: SafetySource): ToolSafety {
  const a = src.annotations
  const safety: ToolSafety = { ...STRICT_SAFETY }
  if (a?.readOnlyHint === true && a.destructiveHint !== true) safety.effect = 'read'
  if (a?.openWorldHint === false) {
    safety.reachesOutside = false
    safety.outputLabel = 'internal'
  }
  Object.assign(safety, Object.fromEntries(Object.entries(src.declared ?? {}).filter(([, v]) => v !== undefined)))
  // `idempotentHint` is ignored: only an explicit idempotency-key support proposes idempotency.
  if (src.supports?.includes('idempotency-key') === true && src.declared?.idempotency !== false) safety.idempotency = true
  // Output from outside the team's systems is untrusted, whatever the label says.
  if (safety.reachesOutside && safety.outputLabel !== 'confidential') safety.outputLabel = 'untrusted'
  return safety
}

// Higher is stricter.
const strictness: { [K in keyof ToolSafety]: (v: ToolSafety[K]) => number } = {
  effect: (v) => (v === 'write' ? 1 : 0),
  idempotency: (v) => (v ? 0 : 1),
  reachesOutside: (v) => (v ? 1 : 0),
  outputLabel: (v) => ({ trusted: 0, internal: 1, untrusted: 2, confidential: 2 })[v],
}
const SAFETY_KEYS = ['effect', 'idempotency', 'reachesOutside', 'outputLabel'] as const

/** True when `a` is looser than `b` for the key. The generic ties each key to its own value type. */
function looser<K extends keyof ToolSafety>(k: K, a: ToolSafety, b: ToolSafety): boolean {
  const rank: (v: ToolSafety[K]) => number = strictness[k]
  return rank(a[k]) < rank(b[k])
}

/**
 * The safety a tool runs with: the confirmed values (strict where unconfirmed), tightened by hints and
 * declarations. Hints never loosen. `needsConfirmation` lists the keys where the proposal is looser than that.
 */
export function resolveSafety(
  src: SafetySource,
  confirmed?: Partial<ToolSafety>,
): { safety: ToolSafety; proposed: ToolSafety; needsConfirmation: (keyof ToolSafety)[] } {
  const proposed = proposeSafety(src)
  const safety: ToolSafety = {
    ...STRICT_SAFETY,
    ...Object.fromEntries(Object.entries(confirmed ?? {}).filter(([, v]) => v !== undefined)),
  }
  const a = src.annotations
  if (a?.destructiveHint === true || a?.readOnlyHint === false) safety.effect = 'write'
  if (a?.openWorldHint === true) safety.reachesOutside = true
  const declared = src.declared ?? {}
  for (const k of SAFETY_KEYS) {
    const d = declared[k]
    if (d !== undefined && looser(k, safety, { ...safety, [k]: d })) Object.assign(safety, { [k]: d })
  }
  if (safety.reachesOutside && safety.outputLabel !== 'confidential') safety.outputLabel = 'untrusted'
  const needsConfirmation = SAFETY_KEYS.filter((k) => looser(k, proposed, safety))
  return { safety, proposed, needsConfirmation }
}

/**
 * Identifies what an admin confirmed: everything the model and the safety rules see of a tool.
 * A confirmation counts only while the tool's fingerprint matches the one it was given for.
 */
export function toolFingerprint(t: { name: string; description: string; inputSchema: Record<string, unknown>; source: SafetySource }): string {
  const def = { name: t.name, description: t.description, inputSchema: t.inputSchema, source: t.source }
  return createHash('sha256').update(canonicalJson(def)).digest('hex')
}
