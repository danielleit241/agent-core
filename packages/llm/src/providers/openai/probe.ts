import type { ModelProfile } from '@agent-core/core'

type ProbeName = 'tools' | 'parallel_tools' | 'json_schema_strict' | 'usage_cost'
type Probe = { name: ProbeName; ok: boolean; detail: string }

type ProbeOpts = { baseUrl: string; apiKey: string; model: string; fetch?: typeof fetch }

type WireReply = {
  choices?: { message?: { content?: unknown; tool_calls?: unknown[] } }[]
  usage?: { cost?: unknown }
}

const PROBE_TIMEOUT_MS = 60_000

const WEATHER_TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for one city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    },
  },
}

const SUM_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'sum',
    strict: true,
    schema: { type: 'object', properties: { sum: { type: 'integer' } }, required: ['sum'], additionalProperties: false },
  },
}

/** Asks a model four fixed questions to propose a profile. A network error throws; an HTTP error fails that probe only. */
export async function probeModel(o: ProbeOpts): Promise<{ proposed: ModelProfile; probes: Probe[] }> {
  const doFetch = o.fetch ?? fetch
  const url = `${o.baseUrl.replace(/\/+$/, '')}/chat/completions`
  let costSeen = false

  async function ask(
    prompt: string,
    extra: Record<string, unknown>,
  ): Promise<{ ok: true; reply: WireReply } | { ok: false; detail: string }> {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: o.model, messages: [{ role: 'user', content: prompt }], ...extra }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` }
    const reply = ((await res.json().catch(() => undefined)) ?? {}) as WireReply
    if (typeof reply.usage?.cost === 'number') costSeen = true
    return { ok: true, reply }
  }

  const toolCount = (r: WireReply) => r.choices?.[0]?.message?.tool_calls?.length ?? 0

  const tools = await ask('What is the weather in Paris? Use the tool.', { tools: [WEATHER_TOOL] })
  const parallel = await ask('What is the weather in Paris and in Tokyo? Call the tool once for each city in the same turn.', {
    tools: [WEATHER_TOOL],
  })
  const strict = await ask('What is 2+3? Reply with the JSON object.', { response_format: SUM_FORMAT })

  const probes: Probe[] = [
    tools.ok
      ? { name: 'tools', ok: toolCount(tools.reply) >= 1, detail: `${toolCount(tools.reply)} tool call(s)` }
      : { name: 'tools', ok: false, detail: tools.detail },
    parallel.ok
      ? { name: 'parallel_tools', ok: toolCount(parallel.reply) >= 2, detail: `${toolCount(parallel.reply)} tool call(s) in one turn` }
      : { name: 'parallel_tools', ok: false, detail: parallel.detail },
    strict.ok ? strictProbe(strict.reply) : { name: 'json_schema_strict', ok: false, detail: strict.detail },
    { name: 'usage_cost', ok: costSeen, detail: costSeen ? 'usage.cost seen' : 'no usage.cost in any reply' },
  ]
  const ok = (name: ProbeName) => probes.find((p) => p.name === name)?.ok === true
  return {
    proposed: { jsonSchemaStrict: ok('json_schema_strict'), parallelTools: ok('parallel_tools'), usageCost: ok('usage_cost') },
    probes,
  }
}

function strictProbe(reply: WireReply): Probe {
  const content = reply.choices?.[0]?.message?.content
  try {
    const v = JSON.parse(typeof content === 'string' ? content : '') as { sum?: unknown }
    if (Number.isInteger(v.sum)) return { name: 'json_schema_strict', ok: true, detail: 'reply matched the schema' }
  } catch {
    // falls through to the failure result
  }
  return { name: 'json_schema_strict', ok: false, detail: 'reply did not match the schema' }
}
