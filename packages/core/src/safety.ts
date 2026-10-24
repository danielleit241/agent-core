import type { ToolSafety } from './types'

export function inferSafetyFromMcp(a?: {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}): { safety: ToolSafety; needsConfirmation: (keyof ToolSafety)[] } {
  const needsConfirmation: (keyof ToolSafety)[] = []
  if (a?.readOnlyHint === undefined) needsConfirmation.push('effect')
  if (a?.openWorldHint === undefined) needsConfirmation.push('reachesOutside', 'outputLabel')
  return {
    safety: {
      // Hints may only make a tool stricter: destructiveHint overrides readOnlyHint.
      effect: a?.readOnlyHint === true && a?.destructiveHint !== true ? 'read' : 'write',
      // M0: idempotency is never inferred from hints.
      idempotency: false,
      reachesOutside: a?.openWorldHint !== false,
      outputLabel: a?.openWorldHint === false ? 'internal' : 'untrusted',
    },
    needsConfirmation,
  }
}
