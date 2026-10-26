import { MemoryContentStore } from '../support/memory-content-store'
import { wellFormed } from '../support/well-formed'
import { createSecretMatcher } from '../../src/content/secrets'
import { screenContent, screenedToolResponse } from '../../src/content/pipeline'
import { contentHash } from '../../src/content/snapshot'
import { handleOf, offloadPreview, shapeOf } from '../../src/content/offload'

const secrets = createSecretMatcher([])
const offloadOpts = (store: MemoryContentStore, atChars = 8_000) => ({ secrets, offload: { store, atChars } })
const tokens = (s: string) => Math.ceil(s.length / 3)

test('offloads only above the threshold', async () => {
  const store = new MemoryContentStore()
  const inline = await screenContent('a'.repeat(8_000), offloadOpts(store))
  expect(inline.offload).toBeUndefined()
  expect(inline.content).toHaveLength(8_000)
  const big = await screenContent('a'.repeat(8_001), offloadOpts(store))
  expect(big.offload).toEqual({ handle: handleOf(contentHash('a'.repeat(8_001))), hash: contentHash('a'.repeat(8_001)), chars: 8_001, lines: 1 })
  expect(big.content).toContain(big.offload!.handle)
  expect((await store.get([big.offload!.hash])).get(big.offload!.hash)).toBe('a'.repeat(8_001))
})

test('the handle is out_ and the first 12 hex characters of the hash', () => {
  expect(handleOf('3f9a1c2b7d4e99aa')).toBe('out_3f9a1c2b7d4e')
})

test('a 1 MB output adds at most 2,000 tokens', async () => {
  const text = Array.from({ length: 20_000 }, (_, i) => `row ${i},some value,more`).join('\n').padEnd(1_048_576, 'x')
  const { content, offload } = await screenContent(text, offloadOpts(new MemoryContentStore()))
  expect(offload!.chars).toBe(1_048_576)
  // The spec template is about 1,900 characters; the hard bound is the token estimate.
  expect(content.length).toBeLessThanOrEqual(2_100)
  expect(tokens(content)).toBeLessThanOrEqual(2_000)
  expect(content.startsWith(`[Output ${offload!.handle}: 1,048,576 characters, `)).toBe(true)
  expect(content).toContain('characters not shown')
})

test('the preview never splits a surrogate pair', () => {
  // An emoji straddles the head cut (index 1,199-1,200) and the tail cut (400 characters from the end).
  const text = 'a'.repeat(1_199) + '😀' + 'b'.repeat(3_399) + '😀' + 'c'.repeat(399)
  const preview = offloadPreview(text, { handle: 'out_x', hash: 'h', chars: text.length, lines: 1 })
  expect(preview).toContain('characters not shown')
  expect(wellFormed(preview)).toBe(true)
})

test('a text that fits head and tail is shown whole', () => {
  const text = 'x'.repeat(1_500)
  const preview = offloadPreview(text, { handle: 'out_x', hash: 'h', chars: 1_500, lines: 1 })
  expect(preview).toContain(text)
  expect(preview).not.toContain('not shown')
})

test('shapeOf describes a JSON object', () => {
  const text = JSON.stringify({ orders: Array.from({ length: 5_000 }, (_, i) => ({ id: i })), total: 3, next: null })
  expect(shapeOf(text)).toBe('JSON object: "orders" (array of 5,000 objects), "total" (number), "next" (null).')
})

test('shapeOf describes a JSON array of objects', () => {
  const text = JSON.stringify(Array.from({ length: 10_000 }, (_, i) => ({ id: i, sku: 'a', note: 'x' })))
  expect(shapeOf(text)).toBe('JSON array of 10,000 objects with keys "id", "sku", "note".')
})

test('shapeOf is empty for text that is not JSON, and handles 8 MB of JSON', () => {
  expect(shapeOf('id,sku\n1,a')).toBe('')
  expect(shapeOf('{"a":')).toBe('')
  const big = JSON.stringify(['x'.repeat(8_000_000)])
  expect(() => shapeOf(big)).not.toThrow()
})

test('screens before offload so the stored text is clean', async () => {
  const store = new MemoryContentStore()
  const text = 'a'.repeat(25_000) + ' key AKIAIOSFODNN7EXAMPLE ' + 'b'.repeat(25_000)
  const out = await screenContent(text, offloadOpts(store))
  expect(out.redactions).toEqual({ aws_access_key: 1 })
  expect(out.content).not.toContain('AKIAIOSFODNN7EXAMPLE')
  const stored = (await store.get([out.offload!.hash])).get(out.offload!.hash)!
  expect(stored).not.toContain('AKIAIOSFODNN7EXAMPLE')
  expect(stored).toContain('[REDACTED:aws_access_key]')
})

test('content above 8,000,000 characters is stored cut, with a notice', async () => {
  const store = new MemoryContentStore()
  const out = await screenContent('z'.repeat(9_000_000), offloadOpts(store))
  const stored = (await store.get([out.offload!.hash])).get(out.offload!.hash)!
  expect(stored.length).toBeLessThanOrEqual(8_000_000)
  expect(stored).toContain('characters cut')
  expect(out.offload!.chars).toBe(stored.length)
})

test('screenedToolResponse carries the offload, and leaves it out when absent', async () => {
  const store = new MemoryContentStore()
  const big = await screenedToolResponse({ toolCallId: 'c1' }, { content: 'a'.repeat(9_000), isError: false }, ['internal'], offloadOpts(store))
  expect(big.payload).toMatchObject({ toolCallId: 'c1', isError: false, offload: { chars: 9_000 } })
  expect(big.labels).toEqual(['internal'])
  const small = await screenedToolResponse({ toolCallId: 'c2' }, { content: 'ok', isError: false }, ['internal'], offloadOpts(store))
  expect(small.payload).toEqual({ toolCallId: 'c2', content: 'ok', isError: false })
})

const NUL = String.fromCharCode(0)

test('NUL bytes and lone surrogates are replaced before the text is hashed, stored and previewed', async () => {
  const store = new MemoryContentStore()
  const lone = String.fromCharCode(0xd83d)
  const text = `head${NUL}${'a'.repeat(4_000)}${lone}${'b'.repeat(5_000)}${NUL}tail`
  const out = await screenContent(text, offloadOpts(store))
  const stored = (await store.get([out.offload!.hash])).get(out.offload!.hash)!
  expect(stored).toBe(text.replaceAll(NUL, '\ufffd').replace(lone, '\ufffd'))
  expect(out.offload!.hash).toBe(contentHash(stored))
  expect(out.content).not.toContain(NUL)
  expect(wellFormed(out.content)).toBe(true)
})

test('content under the threshold is cleaned the same way', async () => {
  const out = await screenContent(`a${NUL}b`, { secrets })
  expect(out.content).toBe('a\ufffdb')
})

test('the preview of a 1 MB JSON-shaped output is at most 2,100 characters, with the longest header', async () => {
  const keys = Array.from({ length: 12 }, (_, i) => `${'k'.repeat(40)}${i}`)
  const row = Object.fromEntries(keys.map((k) => [k, 'v']))
  const text = JSON.stringify(Array.from({ length: 6_000 }, () => row))
  expect(text.length).toBeGreaterThan(1_000_000)
  const { content } = await screenContent(text, offloadOpts(new MemoryContentStore()))
  expect(content.length).toBeLessThanOrEqual(2_100)
  const obj = JSON.stringify(Object.fromEntries(keys.map((k) => [k, Array.from({ length: 10_000 }, (_, i) => ({ i }))])))
  expect((await screenContent(obj, offloadOpts(new MemoryContentStore()))).content.length).toBeLessThanOrEqual(2_100)
})

test('shapeOf quotes key names, so a key cannot close or fake the header', () => {
  expect(shapeOf(JSON.stringify({ 'a]\nShown: x': 1 }))).toBe('JSON object: "a]\\nShown: x" (number).')
  expect(shapeOf(JSON.stringify([{ id: 1, 'sku x': 2 }]))).toBe('JSON array of 1 objects with keys "id", "sku x".')
})

test('shapeOf cuts at 200 characters without splitting a surrogate pair', () => {
  for (let pad = 0; pad < 4; pad++) {
    const key = `${'k'.repeat(170 + pad)}😀`
    const shape = shapeOf(JSON.stringify({ a: 1, [key]: 2, z: 3 }))
    expect(shape.length).toBeLessThanOrEqual(200)
    expect(wellFormed(shape)).toBe(true)
  }
})
