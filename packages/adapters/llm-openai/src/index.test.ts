import { DEFAULT_MODEL_PROFILE } from '@agent-core/core'
import type { LLMPort, ModelProfile, ToolDescriptor } from '@agent-core/core'
import { startFakeLlm } from '@agent-core/fake-llm'
import { z } from 'zod'
import { createOpenAICompatible, fromWireName, LlmError, toWireName } from './index'

type Fake = Awaited<ReturnType<typeof startFakeLlm>>

const fakes: Fake[] = []
async function fake(script: Parameters<typeof startFakeLlm>[0]): Promise<Fake> {
  const llm = await startFakeLlm(script)
  fakes.push(llm)
  return llm
}
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()))
})

function portFor(llm: Fake, extra: { retryDelaysMs?: number[] } = {}): LLMPort {
  return createOpenAICompatible({ baseUrl: llm.url, apiKey: 'secret-key', models: { default: 'fake' }, ...extra })
}

const req = { model: 'default', messages: [{ role: 'user' as const, content: 'hi' }], tools: [] as ToolDescriptor[] }

const orderGetTool: ToolDescriptor = {
  name: 'orders.get',
  description: 'Get an order',
  inputSchema: { type: 'object', properties: { order_id: { type: 'string' } } },
  safety: { effect: 'read', idempotency: false, reachesOutside: true, outputLabel: 'untrusted' },
  connectionId: 'shop',
}

test('maps dotted tool names to wire-safe names and back', async () => {
  const llm = await fake([{ toolCalls: [{ name: 'orders.get', arguments: { order_id: '1042' } }] }])
  const port = createOpenAICompatible({ baseUrl: llm.url, apiKey: 'x', models: { default: 'fake' } })
  const res = await port.complete({ model: 'default', messages: [{ role: 'user', content: 'hi' }], tools: [orderGetTool] })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((llm.requests[0] as any).tools[0].function.name).toBe('orders__get')
  expect(res.message.toolCalls?.[0]).toMatchObject({ id: expect.stringMatching(/^call_[0-9a-f-]{36}$/), name: 'orders.get', arguments: { order_id: '1042' } })
  expect(res.stopReason).toBe('tool_calls')
})

test('marks malformed tool arguments instead of throwing', async () => {
  const llm = await fake([{ toolCalls: [{ name: 'orders.get', arguments: '{not json' }] }])
  const res = await portFor(llm).complete(req)
  expect(res.message.toolCalls?.[0].argumentsError).toMatch(/JSON/)
  expect(res.message.toolCalls?.[0].arguments).toEqual({})
})

test('marks arguments that are valid JSON but not an object', async () => {
  const llm = await fake([{ toolCalls: [{ name: 'orders.get', arguments: '[1]' }] }])
  const res = await portFor(llm).complete(req)
  expect(res.message.toolCalls?.[0].argumentsError).toBeDefined()
  expect(res.message.toolCalls?.[0].arguments).toEqual({})
})

test('retries on 429 then succeeds', async () => {
  const llm = await fake([{ status: 429 }, { content: 'ok' }])
  const res = await portFor(llm, { retryDelaysMs: [1, 1] }).complete(req)
  expect(res.message.content).toBe('ok')
  expect(res.stopReason).toBe('end')
  expect(llm.requests).toHaveLength(2)
})

test('throws a retryable error after retries are exhausted', async () => {
  const llm = await fake([{ status: 503 }, { status: 503 }, { status: 503 }])
  await expect(portFor(llm, { retryDelaysMs: [1, 1] }).complete(req)).rejects.toMatchObject({ status: 503, retryable: true })
  expect(llm.requests).toHaveLength(3)
})

test('reads usage and provider cost', async () => {
  const llm = await fake([{ content: 'ok', usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 } }])
  expect((await portFor(llm).complete(req)).usage).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: 0.0001 })
})

test('omits costUsd when the provider sends no cost', async () => {
  const llm = await fake([{ content: 'ok' }])
  expect((await portFor(llm).complete(req)).usage).toEqual({ inputTokens: 10, outputTokens: 5 })
})

test('does not retry on 400 and never leaks the API key', async () => {
  const llm = await fake([{ status: 400 }])
  const err = await portFor(llm, { retryDelaysMs: [1, 1] }).complete(req).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(LlmError)
  expect(err).toMatchObject({ status: 400, retryable: false })
  expect((err as Error).message).not.toContain('secret-key')
  expect(llm.requests).toHaveLength(1)
})

test('sends assistant tool calls and tool results in wire format', async () => {
  const llm = await fake([{ content: 'done' }])
  await portFor(llm).complete({
    model: 'default',
    tools: [],
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'orders.get', arguments: { order_id: '1' } }] },
      { role: 'tool', content: '{"ok":true}', toolCallId: 'call_1' },
    ],
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = llm.requests[0] as any
  expect(body.model).toBe('fake')
  expect(body.tools).toBeUndefined()
  expect(body.messages[1]).toEqual({
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'orders__get', arguments: '{"order_id":"1"}' } }],
  })
  expect(body.messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' })
})

test('throws unknown_model_alias before any HTTP call', async () => {
  const llm = await fake([{ content: 'ok' }])
  await expect(portFor(llm).complete({ ...req, model: 'nope' })).rejects.toThrow('unknown_model_alias: nope')
  expect(llm.requests).toHaveLength(0)
})

test('wire name conversion round-trips', () => {
  expect(toWireName('orders.get')).toBe('orders__get')
  expect(fromWireName('orders__get')).toBe('orders.get')
})

function toolNamed(name: string): ToolDescriptor {
  return { ...orderGetTool, name }
}

test.each([
  ['a_.b'],
  ['crm.get contact:v2'],
  ['x'.repeat(30) + '.' + 'y'.repeat(40)],
])('round-trips tool name %s through a wire-safe name', async (name) => {
  const llm = await fake([{ toolCalls: [{ name, arguments: {} }] }])
  const res = await portFor(llm).complete({ ...req, tools: [toolNamed(name)] })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sent = (llm.requests[0] as any).tools[0].function.name as string
  expect(sent).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
  expect(res.message.toolCalls?.[0].name).toBe(name)
})

test('throws tool_name_collision before any HTTP call', async () => {
  const llm = await fake([{ content: 'ok' }])
  await expect(
    portFor(llm).complete({ ...req, tools: [toolNamed('a.b'), toolNamed('a__b')] }),
  ).rejects.toThrow('tool_name_collision: a.b, a__b')
  expect(llm.requests).toHaveLength(0)
})

test('stopReason is tool_calls whenever tool calls are present', async () => {
  const llm = await fake([{ toolCalls: [{ name: 'orders.get', arguments: {} }], finishReason: 'stop' }])
  expect((await portFor(llm).complete(req)).stopReason).toBe('tool_calls')
})

test('blank arguments become {} without an error', async () => {
  const llm = await fake([{ toolCalls: [{ name: 'orders.get', arguments: '  ' }] }])
  const call = (await portFor(llm).complete(req)).message.toolCalls?.[0]
  expect(call?.arguments).toEqual({})
  expect(call?.argumentsError).toBeUndefined()
})

function cannedFetch(message: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch
}
function cannedPort(message: unknown): LLMPort {
  return createOpenAICompatible({ baseUrl: 'http://x/v1', apiKey: 'k', models: { default: 'm' }, fetch: cannedFetch(message) })
}

test('rejects a tool call without a function name', async () => {
  const port = cannedPort({ content: null, tool_calls: [{ id: 'c1', function: { arguments: '{}' } }] })
  await expect(port.complete(req)).rejects.toMatchObject({ name: 'LlmError', status: 200, retryable: false })
})

test('rejects a tool call without an id', async () => {
  const port = cannedPort({ content: null, tool_calls: [{ function: { name: 'a', arguments: '{}' } }] })
  await expect(port.complete(req)).rejects.toMatchObject({ name: 'LlmError', status: 200, retryable: false })
})

test('joins text parts when content is an array', async () => {
  const port = cannedPort({ content: [{ type: 'text', text: 'foo' }, { type: 'image' }, { type: 'text', text: 'bar' }] })
  expect((await port.complete(req)).message.content).toBe('foobar')
})

test('trims trailing slashes from baseUrl', async () => {
  const llm = await fake([{ content: 'ok' }])
  const port = createOpenAICompatible({ baseUrl: `${llm.url}/`, apiKey: 'k', models: { default: 'fake' } })
  expect((await port.complete(req)).message.content).toBe('ok')
})

test('retries network errors then throws a retryable status-0 error', async () => {
  const llm = await startFakeLlm([])
  const port = portFor(llm, { retryDelaysMs: [1, 1] })
  await llm.close()
  await expect(port.complete(req)).rejects.toMatchObject({ name: 'LlmError', status: 0, retryable: true })
})

test('finish_reason tool_calls without any tool call is an end', async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: 'hello' }, finish_reason: 'tool_calls' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch
  const port = createOpenAICompatible({ baseUrl: 'http://x/v1', apiKey: 'k', models: { default: 'm' }, fetch: fetchFn })
  const res = await port.complete(req)
  expect(res.stopReason).toBe('end')
  expect(res.message.toolCalls).toBeUndefined()
})

test('provider tool-call ids are replaced by our own, so reuse across turns is harmless', async () => {
  const port = cannedPort({ content: null, tool_calls: [{ id: 'call_0', function: { name: 'a', arguments: '{}' } }] })
  const first = (await port.complete(req)).message.toolCalls![0]!.id
  const second = (await port.complete(req)).message.toolCalls![0]!.id
  expect(first).toMatch(/^call_[0-9a-f-]{36}$/)
  expect(second).toMatch(/^call_[0-9a-f-]{36}$/)
  expect(first).not.toBe(second)
})

test('a provider id like "constructor" comes back as a call_ UUID', async () => {
  const port = cannedPort({ content: null, tool_calls: [{ id: 'constructor', function: { name: 'a', arguments: '{}' } }] })
  expect((await port.complete(req)).message.toolCalls![0]!.id).toMatch(/^call_[0-9a-f-]{36}$/)
})

test('merges consecutive system messages into one, because some providers keep only the first', async () => {
  const llm = await fake([{ content: 'ok' }])
  await portFor(llm).complete({
    ...req,
    messages: [
      { role: 'system', content: 'Instructions' },
      { role: 'system', content: 'Requester: cus_1 (roles: customer)' },
      { role: 'system', content: 'Current time: 2026-01-01T00:00:00.000Z', volatile: true },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'Later note' },
    ],
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((llm.requests[0] as any).messages).toEqual([
    { role: 'system', content: 'Instructions\n\nRequester: cus_1 (roles: customer)\n\nCurrent time: 2026-01-01T00:00:00.000Z' },
    { role: 'user', content: 'hi' },
    { role: 'system', content: 'Later note' },
  ])
})

describe('model profiles and structured output', () => {
  const schema = z.object({ sum: z.number().int() })
  const outReq = { ...req, output: { name: 'sum', schema } }
  const withProfile = (llm: Fake, profile: ModelProfile) => {
    const seen: string[] = []
    const port = createOpenAICompatible({
      baseUrl: llm.url,
      apiKey: 'x',
      models: { default: 'real-id' },
      retryDelaysMs: [],
      profile: (m) => {
        seen.push(m)
        return profile
      },
    })
    return { port, seen }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sent = (llm: Fake) => llm.requests as any[]

  test('strict profile sends response_format with a closed schema', async () => {
    const llm = await fake([{ content: '{"sum":5}' }])
    const { port, seen } = withProfile(llm, { ...DEFAULT_MODEL_PROFILE, jsonSchemaStrict: true })
    const res = await port.complete(outReq)
    expect(seen).toEqual(['real-id'])
    expect(sent(llm)[0].response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'sum', strict: true, schema: { type: 'object', additionalProperties: false } },
    })
    expect(res.message.content).toBe('{"sum":5}')
  })

  test('non-strict profile adds a user message and returns normalised JSON', async () => {
    const llm = await fake([{ content: '{ "sum": 5 }' }])
    const res = await withProfile(llm, DEFAULT_MODEL_PROFILE).port.complete(outReq)
    const body = sent(llm)[0]
    expect(body.response_format).toBeUndefined()
    // A user message: some providers keep only the first system message.
    expect(body.messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('Reply with only a JSON object that matches this JSON Schema:'),
    })
    expect(res.message.content).toBe('{"sum":5}')
  })

  test('accepts JSON inside a Markdown fence without a retry', async () => {
    const llm = await fake([{ content: '```json\n{"sum": 5}\n```' }])
    const res = await withProfile(llm, DEFAULT_MODEL_PROFILE).port.complete(outReq)
    expect(res.message.content).toBe('{"sum":5}')
    expect(sent(llm)).toHaveLength(1)
  })

  test('a strict profile falls back to validate-and-retry when the schema has an optional field', async () => {
    // Strict providers require every property to be listed in `required`, so this schema would be refused.
    const optional = { ...req, output: { name: 'note', schema: z.object({ sum: z.number(), note: z.object({ text: z.string().optional() }) }) } }
    const llm = await fake([{ content: '{"sum":5,"note":{}}' }])
    const res = await withProfile(llm, { ...DEFAULT_MODEL_PROFILE, jsonSchemaStrict: true }).port.complete(optional)
    expect(sent(llm)[0].response_format).toBeUndefined()
    expect(sent(llm)[0].messages.at(-1).content).toContain('Reply with only a JSON object')
    expect(res.message.content).toBe('{"sum":5,"note":{}}')
  })

  test('structured output together with tools is refused before any request', async () => {
    const llm = await fake([{ content: '{"sum":5}' }])
    const err = await withProfile(llm, DEFAULT_MODEL_PROFILE)
      .port.complete({ ...outReq, tools: [orderGetTool] })
      .catch((e: unknown) => e)
    expect(err).toMatchObject({ message: 'output_with_tools_not_supported: sum' })
    expect(llm.requests).toHaveLength(0)
  })

  test('a strict profile still validates the reply', async () => {
    const llm = await fake([{ content: '{"sum":"five"}' }])
    const err = await withProfile(llm, { ...DEFAULT_MODEL_PROFILE, jsonSchemaStrict: true }).port.complete(outReq).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).retryable).toBe(false)
  })

  test('retries with the bad reply and the issue, then sums usage', async () => {
    const llm = await fake([
      { content: 'nope', usage: { prompt_tokens: 10, completion_tokens: 1, cost: 0.5 } },
      { content: '{"sum":"x"}', usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.5 } },
      { content: '{"sum":5}', usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.5 } },
    ])
    const res = await withProfile(llm, DEFAULT_MODEL_PROFILE).port.complete(outReq)
    const third = sent(llm)[2].messages
    expect(third.at(-2)).toEqual({ role: 'assistant', content: '{"sum":"x"}' })
    expect(third.at(-1).content).toMatch(/^That reply was not valid JSON for the schema: sum: .*Reply again with only the JSON object\.$/)
    expect(res.usage).toEqual({ inputTokens: 30, outputTokens: 6, costUsd: 1.5 })
  })

  test('three bad replies throw output_invalid', async () => {
    const llm = await fake([{ content: 'a' }, { content: 'b' }, { content: 'c' }])
    const err = await withProfile(llm, DEFAULT_MODEL_PROFILE).port.complete(outReq).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect(err).toMatchObject({ message: 'output_invalid: sum', status: 422, retryable: false })
    expect(llm.requests).toHaveLength(3)
  })

  test('computes cost from prices when the provider sends none', async () => {
    const llm = await fake([{ content: 'ok', usage: { prompt_tokens: 1000, completion_tokens: 500 } }])
    const res = await withProfile(llm, { ...DEFAULT_MODEL_PROFILE, priceInPerMTok: 2, priceOutPerMTok: 10 }).port.complete(req)
    expect(res.usage.costUsd).toBeCloseTo((1000 * 2 + 500 * 10) / 1e6)
  })

  test('provider cost wins; no cost without both prices', async () => {
    const llm = await fake([
      { content: 'ok', usage: { prompt_tokens: 1000, completion_tokens: 500, cost: 0.42 } },
      { content: 'ok', usage: { prompt_tokens: 1000, completion_tokens: 500 } },
    ])
    const port = withProfile(llm, { ...DEFAULT_MODEL_PROFILE, priceInPerMTok: 2 }).port
    expect((await port.complete(req)).usage.costUsd).toBe(0.42)
    expect((await port.complete(req)).usage).not.toHaveProperty('costUsd')
  })
})

test('an error names the HTTP status only: provider text can echo credentials and would reach the event log', async () => {
  const llm = await fake([{ status: 401 }])
  const err = await portFor(llm).complete(req).catch((e: unknown) => e)
  expect((err as Error).message).toBe('LLM provider returned HTTP 401')
})

test('a network error does not carry the cause text', async () => {
  const llm = await startFakeLlm([])
  const port = portFor(llm, { retryDelaysMs: [1] })
  await llm.close()
  const err = await port.complete(req).catch((e: unknown) => e)
  expect((err as Error).message).toBe('LLM request failed: network error')
})
