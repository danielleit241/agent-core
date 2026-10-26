import { canonicalArgs, repeatedCalls, stalledTurns } from '../../src/runner/loops'
import type { Message, ToolCall } from '../../src/types'

let ids = 0
const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: `c${++ids}`, name, arguments: args })
const turn = (...calls: ToolCall[]): Message => ({ role: 'assistant', content: '', toolCalls: calls })
const result = (c: ToolCall, content: string): Message => ({ role: 'tool', toolCallId: c.id, content })

test('canonicalArgs ignores key order at every depth', () => {
  expect(canonicalArgs({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: 2 } })).toBe(canonicalArgs({ a: { c: 2, d: [1, { x: 1, y: 2 }] }, b: 1 }))
  expect(canonicalArgs({ a: 1 })).not.toBe(canonicalArgs({ a: '1' }))
})

test('repeatedCalls counts earlier calls with the same tool and arguments, in earlier turns and earlier in the same turn', () => {
  const a1 = call('orders.get', { id: 1, x: true })
  const b = call('orders.get', { id: 2 })
  const a2 = call('orders.get', { x: true, id: 1 })
  const a3 = call('orders.get', { id: 1, x: true })
  const messages = [turn(a1, b), result(a1, 'r'), result(b, 'r'), turn(a2, a3)]
  expect(repeatedCalls(messages, a1)).toBe(0)
  expect(repeatedCalls(messages, a2)).toBe(1)
  expect(repeatedCalls(messages, a3)).toBe(2)
  expect(repeatedCalls(messages, b)).toBe(0)
})

test('stalledTurns counts the trailing turns whose every result repeats an earlier call and result', () => {
  const a1 = call('t', { q: 'a' })
  const b1 = call('t', { q: 'b' })
  const a2 = call('t', { q: 'a' })
  const b2 = call('t', { q: 'b' })
  const messages: Message[] = [turn(a1, b1), result(a1, 'A'), result(b1, 'B'), turn(a2), result(a2, 'A'), turn(b2), result(b2, 'B')]
  expect(stalledTurns(messages)).toBe(2)
})

test('stalledTurns resets on a turn with a new result, and a different call with the same result is new', () => {
  const a1 = call('t', { q: 'a' })
  const a2 = call('t', { q: 'a' })
  const a3 = call('t', { q: 'a' })
  const c = call('t', { q: 'c' })
  const a4 = call('t', { q: 'a' })
  const messages: Message[] = [
    turn(a1), result(a1, '[]'),
    turn(a2), result(a2, '[]'),
    turn(a3), result(a3, 'changed'),
    turn(c), result(c, '[]'),
    turn(a4), result(a4, 'changed'),
  ]
  expect(stalledTurns(messages)).toBe(1)
})

test('stalledTurns is 0 without tool turns', () => {
  expect(stalledTurns([{ role: 'user', content: 'hi' }])).toBe(0)
})
