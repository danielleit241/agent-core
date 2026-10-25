import { requestHash } from './request-hash'
import type { Message, ToolDescriptor } from '../types'

const tool = (name: string, over: Partial<ToolDescriptor> = {}): ToolDescriptor => ({
  name,
  description: `Tool ${name}`,
  inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  safety: { effect: 'read', idempotency: false, reachesOutside: true, outputLabel: 'internal' },
  connectionId: 'shop',
  ...over,
})

const call = (id: string, args: Record<string, unknown> = { a: 1, b: 2 }) => ({ id, name: 'orders.get', arguments: args })

const messages = (callId = 'call_1'): Message[] => [
  { role: 'system', content: 'You are a support agent.' },
  { role: 'user', content: 'Where is my order?' },
  { role: 'assistant', content: '', toolCalls: [call(callId)] },
  { role: 'tool', toolCallId: callId, content: 'delivered' },
]

const base = () => ({ model: 'm', messages: messages(), tools: [tool('orders.get'), tool('payments.refund')] })

describe('requestHash', () => {
  test('returns 64 hex characters', () => {
    expect(requestHash(base())).toMatch(/^[0-9a-f]{64}$/)
  })

  test('ignores tool call ids', () => {
    expect(requestHash({ ...base(), messages: messages('call_99') })).toBe(requestHash(base()))
  })

  test('ignores volatile messages', () => {
    const plain = base()
    const withTime = (t: string) => ({
      ...plain,
      messages: [
        plain.messages[0]!,
        { role: 'system', content: `Current time: ${t}`, volatile: true } as Message,
        ...plain.messages.slice(1),
      ],
    })
    expect(requestHash(withTime('2026-01-01T00:00:00.000Z'))).toBe(requestHash(plain))
    expect(requestHash(withTime('2027-05-05T00:00:00.000Z'))).toBe(requestHash(plain))
  })

  test('ignores key order and whitespace runs', () => {
    const a = base()
    const b = {
      ...base(),
      messages: [
        { role: 'system', content: 'You are a  support agent.\n' },
        { role: 'user', content: 'Where is   my order?' },
        { role: 'assistant', content: '', toolCalls: [call('call_1', { b: 2, a: 1 })] },
        { role: 'tool', toolCallId: 'call_1', content: 'delivered' },
      ] as Message[],
    }
    expect(requestHash(b)).toBe(requestHash(a))
    expect(requestHash({ ...a, messages: [{ role: 'user', content: 'a  b\n' }] })).toBe(
      requestHash({ ...a, messages: [{ role: 'user', content: 'a b' }] }),
    )
  })

  test('ignores tool order and description', () => {
    const a = base()
    const b = { ...a, tools: [tool('payments.refund', { description: 'other' }), tool('orders.get', { description: 'x' })] }
    expect(requestHash(b)).toBe(requestHash(a))
  })

  test('changes with model, content, tool name or input schema', () => {
    const a = base()
    const hashes = new Set([
      requestHash(a),
      requestHash({ ...a, model: 'm2' }),
      requestHash({ ...a, messages: [{ role: 'user', content: 'Different' }] }),
      requestHash({ ...a, tools: [tool('orders.list'), tool('payments.refund')] }),
      requestHash({ ...a, tools: [tool('orders.get', { inputSchema: { type: 'object' } }), tool('payments.refund')] }),
    ])
    expect(hashes.size).toBe(5)
  })
})
