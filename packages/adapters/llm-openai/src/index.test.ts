import type { LLMPort, ToolDescriptor } from '@agent-core/core'
import { startFakeLlm } from '@agent-core/fake-llm'
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
