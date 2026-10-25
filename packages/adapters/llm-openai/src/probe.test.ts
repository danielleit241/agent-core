import { startFakeLlm } from '@agent-core/fake-llm'
import { probeModel } from './probe'

const fakes: Awaited<ReturnType<typeof startFakeLlm>>[] = []
async function fake(script: Parameters<typeof startFakeLlm>[0]) {
  const llm = await startFakeLlm(script)
  fakes.push(llm)
  return llm
}
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()))
})

const city = (c: string) => ({ name: 'get_weather', arguments: { city: c } })

test('proposes a full profile when every probe passes', async () => {
  const llm = await fake([
    { toolCalls: [city('Paris')] },
    { toolCalls: [city('Paris'), city('Tokyo')] },
    { content: '{"sum":5}', usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } },
  ])
  const res = await probeModel({ baseUrl: llm.url, apiKey: 'k', model: 'real-id' })
  expect(res.proposed).toEqual({ jsonSchemaStrict: true, parallelTools: true, usageCost: true })
  expect(res.probes.map((p) => [p.name, p.ok])).toEqual([
    ['tools', true],
    ['parallel_tools', true],
    ['json_schema_strict', true],
    ['usage_cost', true],
  ])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reqs = llm.requests as any[]
  expect(reqs[0].model).toBe('real-id')
  expect(reqs[2].response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true } })
})

test('a model that ignores tools and the schema gets an all-false proposal', async () => {
  const llm = await fake([{ content: 'sunny' }, { content: 'sunny' }, { content: 'five' }])
  const res = await probeModel({ baseUrl: llm.url, apiKey: 'k', model: 'm' })
  expect(res.proposed).toEqual({ jsonSchemaStrict: false, parallelTools: false, usageCost: false })
  expect(res.probes.every((p) => !p.ok)).toBe(true)
})

test('a 4xx fails only that probe', async () => {
  const llm = await fake([{ toolCalls: [city('Paris')] }, { toolCalls: [city('Paris'), city('Tokyo')] }, { status: 400 }])
  const res = await probeModel({ baseUrl: llm.url, apiKey: 'k', model: 'm' })
  expect(res.probes.find((p) => p.name === 'json_schema_strict')).toMatchObject({ ok: false, detail: 'HTTP 400' })
  expect(res.proposed).toMatchObject({ parallelTools: true, jsonSchemaStrict: false })
})

test('a network error throws', async () => {
  const failing = (() => Promise.reject(new Error('down'))) as unknown as typeof fetch
  await expect(probeModel({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', fetch: failing })).rejects.toThrow('down')
})
