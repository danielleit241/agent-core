import { isDeepStrictEqual } from 'node:util'
import { metricsOf } from './metrics'
import type { Outcome, Scenario } from '../scenario'

/** Returns one message per failed expectation; an empty array means the scenario passed. */
export function gradeDeterministic(s: Scenario, o: Outcome): string[] {
  const failures: string[] = []
  const { expect } = s
  if (o.status !== expect.status) failures.push(`status: expected ${expect.status}, got ${o.status}`)
  if (expect.waitingReason !== undefined && o.waitingReason !== expect.waitingReason) {
    failures.push(`waitingReason: expected ${expect.waitingReason}, got ${o.waitingReason ?? 'none'}`)
  }

  const requested = o.events.flatMap((e) => (e.type === 'tool.requested' ? [e.payload] : []))
  for (const want of expect.toolsCalled ?? []) {
    const hit = requested.some(
      (r) =>
        r.tool === want.tool &&
        Object.entries(want.args ?? {}).every(([k, v]) => k in r.args && isDeepStrictEqual(r.args[k], v)),
    )
    if (!hit) {
      const args = want.args ? ` with ${JSON.stringify(want.args)}` : ''
      failures.push(`toolsCalled: ${want.tool}${args} was not called`)
    }
  }
  // A call stopped by the rule gate or a human still counts: the agent tried it.
  const decided = o.events.flatMap((e) => (e.type === 'rule.decided' ? [e.payload.tool] : []))
  for (const tool of expect.toolsNotCalled ?? []) {
    if (requested.some((r) => r.tool === tool) || decided.includes(tool)) failures.push(`toolsNotCalled: ${tool} was called`)
  }

  const { peakInputTokens } = metricsOf(o.events)
  if (expect.peakInputTokensAtMost !== undefined && peakInputTokens > expect.peakInputTokensAtMost) {
    failures.push(`peakInputTokensAtMost: expected at most ${expect.peakInputTokensAtMost}, got ${peakInputTokens}`)
  }
  for (const [tool, want] of Object.entries(expect.toolCallCount ?? {})) {
    const got = requested.filter((r) => r.tool === tool).length
    if (got !== want) failures.push(`toolCallCount: ${tool} expected ${want}, got ${got}`)
  }

  const { state } = expect
  if (state?.refunds && !isDeepStrictEqual(state.refunds, o.shop.refunds)) {
    failures.push(`state.refunds: expected ${JSON.stringify(state.refunds)}, got ${JSON.stringify(o.shop.refunds)}`)
  }
  if (state?.sizeChanges && !isDeepStrictEqual(state.sizeChanges, o.shop.sizeChanges)) {
    failures.push(
      `state.sizeChanges: expected ${JSON.stringify(state.sizeChanges)}, got ${JSON.stringify(o.shop.sizeChanges)}`,
    )
  }
  return failures
}
