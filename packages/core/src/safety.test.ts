import { inferSafetyFromMcp } from './safety'

test('no annotations gives the strictest defaults and asks for confirmation', () => {
  expect(inferSafetyFromMcp(undefined)).toEqual({
    safety: { effect: 'write', idempotency: false, reachesOutside: true, outputLabel: 'untrusted' },
    needsConfirmation: ['effect', 'reachesOutside', 'outputLabel'],
  })
})
test('readOnly and closed-world hints give an internal read tool', () => {
  expect(inferSafetyFromMcp({ readOnlyHint: true, openWorldHint: false }).safety).toEqual({
    effect: 'read',
    idempotency: false,
    reachesOutside: false,
    outputLabel: 'internal',
  })
})
test('idempotentHint alone never sets idempotency', () => {
  expect(inferSafetyFromMcp({ idempotentHint: true }).safety.idempotency).toBe(false)
})
test('explicit hints need no confirmation', () => {
  expect(inferSafetyFromMcp({ readOnlyHint: false, openWorldHint: false }).needsConfirmation).toEqual([])
})
test('destructiveHint forces write even when readOnlyHint is true', () => {
  expect(inferSafetyFromMcp({ readOnlyHint: true, destructiveHint: true, openWorldHint: false }).safety.effect).toBe('write')
})
