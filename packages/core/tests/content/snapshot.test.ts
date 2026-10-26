import { MemoryContentStore } from '../support/memory-content-store'
import { canonicalJson } from '../../src/events/hash'
import { contentHash, snapshotRequest, type Manifest } from '../../src/content/snapshot'
import type { Message, ToolDescriptor } from '../../src/types'

const TOOL: ToolDescriptor = {
  name: 'orders.get',
  description: 'Get an order',
  inputSchema: { type: 'object' },
  safety: { effect: 'read', idempotency: false, reachesOutside: true, outputLabel: 'internal' },
  connectionId: 'shop',
}

test('contentHash is the sha256 hex of the text', () => {
  expect(contentHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

const manifestOf = async (store: MemoryContentStore, snapshot: string): Promise<Manifest> =>
  JSON.parse((await store.get([snapshot])).get(snapshot)!) as Manifest

test('a message part is canonical JSON of its sent fields; a tool part of name, description and schema; the manifest lists them', async () => {
  const store = new MemoryContentStore()
  const messages: Message[] = [
    { role: 'system', content: 'be brief' },
    { role: 'system', content: 'Current time: now', volatile: true },
    { role: 'assistant', content: 'hi', toolCalls: [{ id: 'c1', name: 'orders.get', arguments: { a: 1 } }] },
    { role: 'tool', content: 'ok', toolCallId: 'c1' },
  ]
  const snap = await snapshotRequest(store, { messages, tools: [TOOL] })
  const manifest = await manifestOf(store, snap.snapshot)
  const texts = await store.get(manifest.messages.filter((x): x is string => typeof x === 'string'))
  const part = (i: number) => (typeof manifest.messages[i] === 'string' ? texts.get(manifest.messages[i] as string) : undefined)
  expect(part(0)).toBe(canonicalJson({ role: 'system', content: 'be brief' }))
  // The volatile item is inline in the manifest, with the volatile flag dropped, and has no blob of its own.
  expect(manifest.messages[1]).toEqual({ inline: canonicalJson({ role: 'system', content: 'Current time: now' }) })
  expect(store.blobs.has(contentHash(canonicalJson({ role: 'system', content: 'Current time: now' })))).toBe(false)
  expect(part(2)).toBe(canonicalJson({ role: 'assistant', content: 'hi', toolCalls: [{ id: 'c1', name: 'orders.get', arguments: { a: 1 } }] }))
  expect(part(3)).toBe(canonicalJson({ role: 'tool', content: 'ok', toolCallId: 'c1' }))
  const toolJson = canonicalJson({ name: 'orders.get', description: 'Get an order', inputSchema: { type: 'object' } })
  expect(manifest.tools).toEqual([contentHash(toolJson)])
  expect((await store.get(manifest.tools)).get(manifest.tools[0]!)).toBe(toolJson)
  expect(manifest.output).toBeUndefined()
  const toolCallsJson = canonicalJson([{ id: 'c1', name: 'orders.get', arguments: { a: 1 } }])
  expect(snap.chars).toBe('be brief'.length + 'Current time: now'.length + 2 + toolCallsJson.length + 2 + toolJson.length)
})

test('the manifest holds the output schema when one is passed', async () => {
  const store = new MemoryContentStore()
  const output = { name: 'step_s', schema: { type: 'object' } }
  const snap = await snapshotRequest(store, { messages: [], tools: [], output })
  expect((await manifestOf(store, snap.snapshot)).output).toEqual(output)
})

test('the same part twice is stored once; a second call stores only its manifest and new parts', async () => {
  const store = new MemoryContentStore()
  const m: Message = { role: 'user', content: 'same' }
  const time = (at: string): Message => ({ role: 'system', content: `Current time: ${at}`, volatile: true })
  await snapshotRequest(store, { messages: [m, m, time('1')], tools: [] })
  expect(store.puts).toBe(2) // the user part and the manifest
  await snapshotRequest(store, { messages: [m, time('2')], tools: [] })
  expect(store.puts).toBe(3) // only the new manifest
})
