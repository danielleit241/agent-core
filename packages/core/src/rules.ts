import type { AgentDefinition, Condition, Rule, ToolDescriptor } from './types'

export interface RuleDecision {
  decision: 'allow' | 'require_approval' | 'deny'
  reason: string
}

const OPERATORS = new Set(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'not_in', 'exists'])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

// Containers other than arrays and plain objects compare by identity only.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
}

function bothFinite(a: unknown, b: unknown): a is number {
  return typeof a === 'number' && Number.isFinite(a) && typeof b === 'number' && Number.isFinite(b)
}

function conditionHolds(args: Record<string, unknown>, key: string, cond: Condition): boolean {
  // Fail closed on malformed conditions (the schema should already have rejected them).
  if (!isPlainObject(cond)) return false
  const ops = Object.keys(cond)
  if (ops.length === 0 || ops.some((op) => !OPERATORS.has(op))) return false
  if (('in' in cond && !Array.isArray(cond.in)) || ('not_in' in cond && !Array.isArray(cond.not_in))) return false
  const present = Object.hasOwn(args, key) && args[key] !== undefined
  if (cond.exists === false && present) return false
  if (!present) {
    // A missing value satisfies only `exists: false`.
    return cond.exists === false && ops.every((op) => op === 'exists')
  }
  const v = args[key]
  if ('eq' in cond && !deepEqual(v, cond.eq)) return false
  if ('ne' in cond && deepEqual(v, cond.ne)) return false
  if (cond.in !== undefined && !cond.in.some((x) => deepEqual(v, x))) return false
  if (cond.not_in !== undefined && cond.not_in.some((x) => deepEqual(v, x))) return false
  if (cond.lt !== undefined && !(bothFinite(v, cond.lt) && v < cond.lt)) return false
  if (cond.lte !== undefined && !(bothFinite(v, cond.lte) && v <= cond.lte)) return false
  if (cond.gt !== undefined && !(bothFinite(v, cond.gt) && v > cond.gt)) return false
  if (cond.gte !== undefined && !(bothFinite(v, cond.gte) && v >= cond.gte)) return false
  return true
}

function toolMatches(pattern: string, name: string): boolean {
  if (pattern.endsWith('.*')) return name.startsWith(pattern.slice(0, -1))
  return pattern === name
}

function ruleMatches(rule: Rule, tool: ToolDescriptor, args: Record<string, unknown>): boolean {
  if (!toolMatches(rule.tool, tool.name)) return false
  if (rule.when === undefined) return true
  const entries = Object.entries(rule.when)
  if (entries.length === 0) return false
  return entries.every(([key, cond]) => conditionHolds(args, key, cond))
}

/**
 * Decides whether a tool call may run alone. M0 order: reads are allowed,
 * then the first matching allow rule, then approval. Never throws; it never returns `deny` yet.
 */
export function decide(input: {
  tool: ToolDescriptor
  args: Record<string, unknown>
  agent: AgentDefinition
}): RuleDecision {
  const { tool, args, agent } = input
  if (tool.safety.effect === 'read') return { decision: 'allow', reason: 'read' }
  const index = agent.allow.findIndex((rule) => ruleMatches(rule, tool, args))
  if (index >= 0) return { decision: 'allow', reason: `allow[${index}]` }
  return { decision: 'require_approval', reason: 'write_requires_approval' }
}
