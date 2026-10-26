import type { RunProjection } from '../events/projection'
import { DEFAULT_CACHE_TTL_S, type EventPayloads, type Label, type ToolCall, type ToolDescriptor } from '../types'
import { SUBRUN_STARTED } from '../events/projection'
import { isBuiltin } from './builtins'
import { canonicalArgs } from './loops'

export type CachedRead = {
  fromToolCallId: string
  ageS: number
  payload: EventPayloads['tool.responded']
  labels: Label[]
}

/** Whether a call sent after a read may have changed what the read would return on `connectionId`. */
function clears(tool: string, connectionId: string, toolsByName: Record<string, ToolDescriptor>): boolean {
  // A child run of a workflow may write anywhere.
  if (tool === SUBRUN_STARTED) return true
  if (isBuiltin(tool)) return false
  const t = Object.hasOwn(toolsByName, tool) ? toolsByName[tool] : undefined
  // A tool the runner does not know may be a write to any connection: fail safe.
  if (t === undefined) return true
  return t.safety.effect === 'write' && t.connectionId === connectionId
}

/**
 * The latest earlier read in this run with the same tool and arguments whose answer can still be served:
 * it was not an error, it is younger than the tool's TTL, and no write to the same connection was sent since.
 * Derived from the event log only. Call it for a fresh call (no `tool.requested` yet).
 */
export function findCachedRead(
  proj: RunProjection,
  call: ToolCall,
  tool: ToolDescriptor,
  toolsByName: Record<string, ToolDescriptor>,
  now: Date,
): CachedRead | null {
  if (tool.safety.effect !== 'read' || isBuiltin(tool.name) || tool.changedSinceReview === true) return null
  const ttlS = tool.cacheTtlS ?? DEFAULT_CACHE_TTL_S
  if (ttlS <= 0) return null
  const args = canonicalArgs(call.arguments)
  for (let i = proj.completedCalls.length - 1; i >= 0; i--) {
    const c = proj.completedCalls[i]!
    if (c.tool !== call.name || c.payload.isError || canonicalArgs(c.args) !== args) continue
    // The answer carries the label the tool had then; a tool whose output label changed since is called again.
    if (c.labels.length !== 1 || c.labels[0] !== tool.safety.outputLabel) return null
    const ageS = Math.max(0, (now.getTime() - Date.parse(c.respondedAt)) / 1000)
    if (ageS >= ttlS) return null
    if (proj.sentTools.slice(c.sentBefore).some((t) => clears(t, tool.connectionId, toolsByName))) return null
    return { fromToolCallId: c.toolCallId, ageS: Math.floor(ageS), payload: c.payload, labels: c.labels }
  }
  return null
}
