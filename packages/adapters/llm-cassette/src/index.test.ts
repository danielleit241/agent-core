import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LLMPort, Message } from '@agent-core/core'
import { CassetteMissError, emptyCassette, loadCassette, recordingLlm, replaceTagged, replayingLlm, saveCassette, taggedCassette } from './index'

type Res = Awaited<ReturnType<LLMPort['complete']>>

const usage = { inputTokens: 3, outputTokens: 4 } as unknown as Res['usage']

// The fake is built with an API key, as a real adapter would be; the key must never reach the cassette.
function fakeInner(responses: Res[], apiKey = 'sk-secret-key'): LLMPort & { calls: number } {
  const inner = {
    calls: 0,
    apiKey,
    async complete() {
      const r = responses[inner.calls++]
      if (!r) throw new Error('no more responses')
      return r
    },
  }
  return inner
}

const text = (content: string): Res => ({ message: { role: 'assistant', content }, usage, stopReason: 'end' })
const toolRes = (id: string): Res => ({
  message: { role: 'assistant', content: '', toolCalls: [{ id, name: 'orders.get', arguments: { id: '1' } }] },
  usage,
  stopReason: 'tool_calls',
})

const req = (content = 'hello', time = 'T1') => ({
  model: 'm',
  messages: [
    { role: 'system', content: `Current time: ${time}`, volatile: true },
    { role: 'user', content },
  ] as Message[],
  tools: [],
})

describe('llm-cassette', () => {
  test('record then replay returns the recorded response', async () => {
    const cassette = emptyCassette()
    const recorded = await recordingLlm(fakeInner([text('hi')]), cassette).complete(req())
    const replayed = await replayingLlm(cassette).complete(req())
    expect(replayed.message.content).toBe(recorded.message.content)
    expect(replayed.stopReason).toBe(recorded.stopReason)
    expect(replayed.usage).toEqual(recorded.usage)
  })

  test('replay hits when only the volatile time differs', async () => {
    const cassette = emptyCassette()
    await recordingLlm(fakeInner([text('hi')]), cassette).complete(req('hello', 'T1'))
    const replayed = await replayingLlm(cassette).complete(req('hello', 'T2'))
    expect(replayed.message.content).toBe('hi')
  })

  test('changed content throws a non-retryable CassetteMissError', async () => {
    const cassette = emptyCassette()
    await recordingLlm(fakeInner([text('hi')]), cassette).complete(req())
    const err = await replayingLlm(cassette).complete(req('other')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CassetteMissError)
    expect((err as CassetteMissError).retryable).toBe(false)
    expect((err as CassetteMissError).hash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('same hash returns entries in order, then misses', async () => {
    const cassette = emptyCassette()
    await recordingLlm(fakeInner([text('one'), text('two')]), cassette)
      .complete(req())
      .then(() => recordingLlm(fakeInner([text('two')]), cassette).complete(req()))
    const replay = replayingLlm(cassette)
    expect((await replay.complete(req())).message.content).toBe('one')
    expect((await replay.complete(req())).message.content).toBe('two')
    expect(replay.misses).toBe(0)
    await expect(replay.complete(req())).rejects.toBeInstanceOf(CassetteMissError)
    expect(replay.misses).toBe(1)
  })

  test('replayed tool-call ids are fresh', async () => {
    const cassette = emptyCassette()
    await recordingLlm(fakeInner([toolRes('call_orig')]), cassette).complete(req())
    const a = (await replayingLlm(cassette).complete(req())).message.toolCalls![0]!.id
    const b = (await replayingLlm(cassette).complete(req())).message.toolCalls![0]!.id
    expect(a).toMatch(/^call_/)
    expect(a).not.toBe('call_orig')
    expect(a).not.toBe(b)
  })

  test('save and load round-trip; file holds no secrets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cassette-'))
    try {
      const path = join(dir, 'c.json')
      expect(await loadCassette(path)).toEqual(emptyCassette())
      const cassette = emptyCassette()
      await recordingLlm(fakeInner([text('hi')], 'sk-secret-key'), cassette).complete(req())
      await saveCassette(path, cassette)
      const raw = await readFile(path, 'utf8')
      expect(raw.endsWith('}\n')).toBe(true)
      expect(raw).not.toMatch(/apiKey|Authorization|sk-secret-key/)
      expect(await loadCassette(path)).toEqual(cassette)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('loadCassette rejects a wrong version', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cassette-'))
    try {
      const { writeFile } = await import('node:fs/promises')
      const path = join(dir, 'c.json')
      await writeFile(path, JSON.stringify({ version: 2, entries: [] }))
      await expect(loadCassette(path)).rejects.toThrow(/version/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('tags', () => {
  test('recorded entries carry the tag, and taggedCassette replays only that tag', async () => {
    const cassette = emptyCassette()
    await recordingLlm(fakeInner([text('for a')]), cassette, 'a').complete(req())
    await recordingLlm(fakeInner([text('for b')]), cassette, 'b').complete(req())
    expect(cassette.entries.map((e) => e.tag)).toEqual(['a', 'b'])
    expect((await replayingLlm(taggedCassette(cassette, 'b')).complete(req())).message.content).toBe('for b')
  })

  test('replaceTagged swaps only the re-recorded tags', async () => {
    const base = emptyCassette()
    await recordingLlm(fakeInner([text('old a')]), base, 'a').complete(req())
    await recordingLlm(fakeInner([text('old b')]), base, 'b').complete(req())
    const fresh = emptyCassette()
    await recordingLlm(fakeInner([text('new a')]), fresh, 'a').complete(req())
    const merged = replaceTagged(base, fresh, ['a'])
    expect(merged.entries.map((e) => [e.tag, e.response.message.content])).toEqual([
      ['b', 'old b'],
      ['a', 'new a'],
    ])
  })
})
