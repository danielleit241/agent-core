import { proposeSafety, resolveSafety, STRICT_SAFETY, toolFingerprint, type SafetySource } from './safety'
import type { ToolSafety } from '../types'

const READ_INTERNAL: ToolSafety = { effect: 'read', idempotency: false, reachesOutside: false, outputLabel: 'internal' }

const cases: {
  name: string
  src: SafetySource
  confirmed?: Partial<ToolSafety>
  safety: ToolSafety
  proposed: ToolSafety
  needs: (keyof ToolSafety)[]
}[] = [
  { name: 'no source is strict and needs nothing', src: {}, safety: STRICT_SAFETY, proposed: STRICT_SAFETY, needs: [] },
  {
    name: 'readOnly and closed-world hints propose read/internal, effective stays strict',
    src: { annotations: { readOnlyHint: true, openWorldHint: false } },
    safety: STRICT_SAFETY,
    proposed: READ_INTERNAL,
    needs: ['effect', 'reachesOutside', 'outputLabel'],
  },
  {
    name: 'a full confirmation accepts the proposal',
    src: { annotations: { readOnlyHint: true, openWorldHint: false } },
    confirmed: READ_INTERNAL,
    safety: READ_INTERNAL,
    proposed: READ_INTERNAL,
    needs: [],
  },
  {
    name: 'destructiveHint tightens a confirmed read to write',
    src: { annotations: { readOnlyHint: true, destructiveHint: true, openWorldHint: false } },
    confirmed: { effect: 'read' },
    safety: STRICT_SAFETY,
    proposed: { ...READ_INTERNAL, effect: 'write' },
    needs: ['reachesOutside', 'outputLabel'],
  },
  {
    name: 'readOnlyHint false tightens a confirmed read to write',
    src: { annotations: { readOnlyHint: false } },
    confirmed: { effect: 'read' },
    safety: STRICT_SAFETY,
    proposed: STRICT_SAFETY,
    needs: [],
  },
  {
    name: 'openWorldHint true tightens a confirmed closed read tool',
    src: { annotations: { readOnlyHint: true, openWorldHint: true } },
    confirmed: READ_INTERNAL,
    safety: { effect: 'read', idempotency: false, reachesOutside: true, outputLabel: 'untrusted' },
    proposed: { ...STRICT_SAFETY, effect: 'read' },
    needs: [],
  },
  {
    name: 'confidential stays confidential when tightened',
    src: { annotations: { openWorldHint: true } },
    confirmed: { effect: 'read', reachesOutside: false, outputLabel: 'confidential' },
    safety: { effect: 'read', idempotency: false, reachesOutside: true, outputLabel: 'confidential' },
    proposed: STRICT_SAFETY,
    needs: [],
  },
  {
    name: 'declared reachesOutside true tightens like the hint',
    src: { declared: { reachesOutside: true } },
    confirmed: { reachesOutside: false, outputLabel: 'internal' },
    safety: STRICT_SAFETY,
    proposed: STRICT_SAFETY,
    needs: [],
  },
  {
    name: 'declared effect write tightens a confirmed read',
    src: { declared: { effect: 'write' } },
    confirmed: { effect: 'read' },
    safety: STRICT_SAFETY,
    proposed: STRICT_SAFETY,
    needs: [],
  },
  {
    name: 'supports idempotency-key proposes idempotency and asks for confirmation',
    src: { supports: ['idempotency-key'] },
    safety: STRICT_SAFETY,
    proposed: { ...STRICT_SAFETY, idempotency: true },
    needs: ['idempotency'],
  },
  {
    name: 'declared idempotency false beats the support',
    src: { supports: ['idempotency-key'], declared: { idempotency: false } },
    safety: STRICT_SAFETY,
    proposed: STRICT_SAFETY,
    needs: [],
  },
  {
    name: 'declared overrides hints',
    src: { annotations: { readOnlyHint: true, openWorldHint: false }, declared: { effect: 'write', outputLabel: 'confidential' } },
    safety: STRICT_SAFETY,
    proposed: { effect: 'write', idempotency: false, reachesOutside: false, outputLabel: 'confidential' },
    needs: ['reachesOutside'],
  },
  {
    name: 'idempotentHint is ignored',
    src: { annotations: { idempotentHint: true } },
    safety: STRICT_SAFETY,
    proposed: STRICT_SAFETY,
    needs: [],
  },
]

test.each(cases)('resolveSafety: $name', ({ src, confirmed, safety, proposed, needs }) => {
  expect(resolveSafety(src, confirmed)).toEqual({ safety, proposed, needsConfirmation: needs })
})
test('proposeSafety does not mutate STRICT_SAFETY', () => {
  proposeSafety({ annotations: { readOnlyHint: true, openWorldHint: false }, declared: { idempotency: true } })
  expect(STRICT_SAFETY).toEqual({ effect: 'write', idempotency: false, reachesOutside: true, outputLabel: 'untrusted' })
})
test('undefined values in confirmed or declared do not loosen', () => {
  expect(resolveSafety({ declared: { effect: undefined } }, { effect: undefined }).safety).toEqual(STRICT_SAFETY)
})
test('a stricter declaration tightens every key over a looser confirmation', () => {
  const confirmed = { effect: 'read', idempotency: true, reachesOutside: false, outputLabel: 'internal' } as const
  const r = resolveSafety({ declared: { idempotency: false, outputLabel: 'confidential' } }, confirmed)
  expect(r.safety).toEqual({ effect: 'read', idempotency: false, reachesOutside: false, outputLabel: 'confidential' })
  expect(r.needsConfirmation).toEqual([])
})
test('a tool that reaches outside proposes untrusted output, so confirming it clears every flag', () => {
  const declared = { effect: 'write', idempotency: true, reachesOutside: true, outputLabel: 'internal' } as const
  const r = resolveSafety({ declared }, declared)
  expect(r.safety.outputLabel).toBe('untrusted')
  expect(r.proposed.outputLabel).toBe('untrusted')
  expect(r.needsConfirmation).toEqual([])
})

describe('toolFingerprint', () => {
  const def = {
    name: 'orders.get',
    description: 'Get an order',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    source: { annotations: { readOnlyHint: true } },
  }

  test('is a sha256 hex string, stable across key order', () => {
    const fp = toolFingerprint(def)
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
    expect(toolFingerprint({ source: def.source, inputSchema: { properties: { id: { type: 'string' } }, type: 'object' }, description: def.description, name: def.name })).toBe(fp)
  })

  test.each([
    ['description', { ...def, description: 'Get an order. Also refunds it.' }],
    ['input schema', { ...def, inputSchema: { type: 'object', properties: { id: { type: 'number' } } } }],
    ['annotations', { ...def, source: { annotations: { readOnlyHint: false } } }],
    ['declared safety', { ...def, source: { ...def.source, declared: { outputLabel: 'trusted' as const } } }],
    ['supports', { ...def, source: { ...def.source, supports: ['idempotency-key' as const] } }],
    ['name', { ...def, name: 'orders.find' }],
  ])('changes when the %s changes', (_what, changed) => {
    expect(toolFingerprint(changed)).not.toBe(toolFingerprint(def))
  })

  test('ignores fields that are not part of the definition', () => {
    expect(toolFingerprint({ ...def, connectionId: 'x', confirmed: { effect: 'read' } } as typeof def)).toBe(toolFingerprint(def))
  })
})
