import { MemoryRunStore } from '../support/memory-store'
import { MemoryContentStore } from '../support/memory-content-store'
import type { LLMPort, SubrunPort, ToolInvoker } from '../../src/ports'
import { projectRun } from '../../src/events/projection'
import { advance } from '../../src/runner/workflow'
import type { AgentDefinition, NewEvent, RunStatus, StoredEvent, ToolDescriptor, Workflow } from '../../src/types'

const tool = (name: string, effect: 'read' | 'write'): ToolDescriptor => ({
  name,
  description: name,
  inputSchema: {},
  safety: { effect, idempotency: false, reachesOutside: true, outputLabel: 'internal' },
  connectionId: 'shop',
})
const TOOLS = { 'orders.get': tool('orders.get', 'read'), 'payments.refund': tool('payments.refund', 'write') }

const REFUND: Workflow = {
  start: 'lookup',
  steps: {
    lookup: { kind: 'tool', tool: 'orders.get', args: { order_id: { $ref: '$input.text' } }, next: 'check' },
    check: {
      kind: 'approval',
      reason: 'Refund the order?',
      next: { when: [{ field: 'approved', is: { eq: true }, goto: 'refund' }] },
    },
    refund: { kind: 'tool', tool: 'payments.refund', args: { order_id: { $ref: 'lookup.id' }, amount: { $ref: 'lookup.total' } } },
  },
}

const AGENT: AgentDefinition = {
  id: 'ops',
  instructions: 'You run the refund desk.',
  connections: ['shop'],
  autonomy: 'supervised',
  allow: [{ tool: 'payments.refund' }],
  model: 'm',
}

function fakeTools(results: Record<string, { content: string; isError?: boolean }> = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const tools: ToolInvoker & { calls: typeof calls } = {
    calls,
    async call(t, args) {
      calls.push({ name: t.name, args })
      const r = results[t.name] ?? { content: JSON.stringify({ id: '1042', total: 30 }) }
      return { content: r.content, isError: r.isError ?? false }
    },
  }
  return tools
}

const noLlm: LLMPort = {
  complete: async () => {
    throw new Error('no LLM call expected')
  },
}

async function start(workflow: Workflow, o: { tools?: ToolInvoker; llm?: LLMPort; subruns?: SubrunPort; agent?: AgentDefinition; input?: string } = {}) {
  const store = new MemoryRunStore()
  const created: NewEvent = {
    type: 'run.created',
    payload: { agentId: 'ops', input: { text: o.input ?? '1042' }, workflow: { name: 'refund', definition: workflow } },
    labels: ['untrusted'],
  }
  await store.append('r1', [created])
  const deps = {
    store,
    llm: o.llm ?? noLlm,
    tools: o.tools ?? fakeTools(),
    content: new MemoryContentStore(),
    agent: o.agent ?? AGENT,
    toolsByName: TOOLS,
    agentVersion: 1,
    tenantCostToday: async () => 0,
    random: () => 0.5,
    sleep: async () => undefined,
    ...(o.subruns ? { subruns: o.subruns } : {}),
  }
  return { store, deps }
}
const approve = (toolCallId: string, action: 'approve' | 'reject'): NewEvent[] => [
  { type: 'approval.resolved', payload: { toolCallId, action }, labels: ['trusted'] },
  { type: 'run.state_changed', payload: { from: 'waiting_human', to: 'running' }, labels: [] },
]
const completed = (log: StoredEvent[]) =>
  log.flatMap((e) => (e.type === 'step.completed' ? [[e.payload.stepId, e.payload.output] as const] : []))

test('the refund workflow looks up the order, waits for approval, then refunds with values from the lookup', async () => {
  const tools = fakeTools()
  const { store, deps } = await start(REFUND, { tools })
  expect(await advance('r1', deps)).toBe('waiting_human')
  let log = await store.readEvents('r1')
  expect(log.at(-2)).toMatchObject({ type: 'approval.requested', payload: { toolCallId: 'step:check', tool: 'approval', reason: 'Refund the order?' } })
  expect(projectRun(log, '').awaitingApproval).toEqual(['step:check'])
  expect(tools.calls).toEqual([{ name: 'orders.get', args: { order_id: '1042' } }])

  await store.append('r1', approve('step:check', 'approve'))
  expect(await advance('r1', deps)).toBe('completed')
  log = await store.readEvents('r1')
  expect(tools.calls.at(-1)).toEqual({ name: 'payments.refund', args: { order_id: '1042', amount: 30 } })
  expect(completed(log)).toEqual([
    ['lookup', { id: '1042', total: 30 }],
    ['check', { approved: true }],
    ['refund', { id: '1042', total: 30 }],
  ])
  expect(log.filter((e) => e.type === 'step.started').map((e) => e.payload)).toEqual([
    { stepId: 'lookup', kind: 'tool' },
    { stepId: 'check', kind: 'approval' },
    { stepId: 'refund', kind: 'tool' },
  ])
  expect(projectRun(log, '').output).toBe(JSON.stringify({ id: '1042', total: 30 }))
})

test('a rejected approval step does not fail the run: no branch matches and the run completes without the refund', async () => {
  const tools = fakeTools()
  const { store, deps } = await start(REFUND, { tools })
  await advance('r1', deps)
  await store.append('r1', approve('step:check', 'reject'))
  expect(await advance('r1', deps)).toBe('completed')
  expect(completed(await store.readEvents('r1')).at(-1)).toEqual(['check', { approved: false }])
  expect(tools.calls.map((c) => c.name)).toEqual(['orders.get'])
})

test('a tool step whose rule needs approval waits like an agent run', async () => {
  const tools = fakeTools()
  const { store, deps } = await start(REFUND, { tools, agent: { ...AGENT, allow: [] } })
  await advance('r1', deps)
  await store.append('r1', approve('step:check', 'approve'))
  expect(await advance('r1', deps)).toBe('waiting_human')
  expect(projectRun(await store.readEvents('r1'), '').awaitingApproval).toEqual(['step:refund'])
  expect(tools.calls.map((c) => c.name)).toEqual(['orders.get'])
})

test('a tool step that returns an error fails the run', async () => {
  const { store, deps } = await start(REFUND, { tools: fakeTools({ 'orders.get': { content: 'no such order', isError: true } }) })
  expect(await advance('r1', deps)).toBe('failed')
  expect((await store.readEvents('r1')).at(-2)!.payload).toMatchObject({ message: 'Step "lookup" failed: no such order' })
})

test('a $ref to a field the output does not have fails the run', async () => {
  const { store, deps } = await start(REFUND, { tools: fakeTools({ 'orders.get': { content: 'plain text' } }) })
  await advance('r1', deps)
  await store.append('r1', approve('step:check', 'approve'))
  expect(await advance('r1', deps)).toBe('failed')
  expect((await store.readEvents('r1')).at(-2)!.payload).toMatchObject({ message: 'Step "refund": $ref "lookup.id" has no value.' })
})

test('an llm step gets the input, the previous output and its prompt, and returns JSON that matches its output_schema', async () => {
  const requests: Parameters<LLMPort['complete']>[0][] = []
  const llm: LLMPort = {
    complete: async (req) => {
      requests.push(req)
      return { message: { role: 'assistant', content: '{"intent":"refund"}' }, usage: { inputTokens: 3, outputTokens: 2 }, stopReason: 'end' }
    },
  }
  const wf: Workflow = {
    start: 'lookup',
    steps: {
      lookup: { kind: 'tool', tool: 'orders.get', args: {}, next: 'classify' },
      classify: {
        kind: 'llm',
        prompt: 'Classify the request.',
        output_schema: { type: 'object', properties: { intent: { type: 'string' } }, required: ['intent'] },
      },
    },
  }
  const { store, deps } = await start(wf, { llm })
  expect(await advance('r1', deps)).toBe('completed')
  const req = requests[0]!
  expect(req.tools).toEqual([])
  expect(req.output?.name).toBe('step_classify')
  expect(req.output?.schema.safeParse({ intent: 'x' }).success).toBe(true)
  expect(req.messages[0]).toEqual({ role: 'system', content: 'You run the refund desk.' })
  expect(req.messages.slice(-3)).toEqual([
    { role: 'user', content: '1042' },
    { role: 'user', content: `Output of the previous step: ${JSON.stringify({ id: '1042', total: 30 })}` },
    { role: 'user', content: 'Classify the request.' },
  ])
  expect(completed(await store.readEvents('r1')).at(-1)).toEqual(['classify', { intent: 'refund' }])
  expect(projectRun(await store.readEvents('r1'), '').tokens).toBe(5)
})

test('an llm step without output_schema returns { text }; output that misses its schema fails the run', async () => {
  const say = (content: string): LLMPort => ({
    complete: async () => ({ message: { role: 'assistant', content }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end' }),
  })
  const plain = await start({ start: 's', steps: { s: { kind: 'llm', prompt: 'p' } } }, { llm: say('hello') })
  expect(await advance('r1', plain.deps)).toBe('completed')
  expect(completed(await plain.store.readEvents('r1'))).toEqual([['s', { text: 'hello' }]])

  const typed = await start(
    { start: 's', steps: { s: { kind: 'llm', prompt: 'p', output_schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } } } },
    { llm: say('{"n":"x"}') },
  )
  expect(await advance('r1', typed.deps)).toBe('failed')
  expect((await typed.store.readEvents('r1')).at(-2)!.payload).toMatchObject({ message: 'Step "s": the LLM output does not match output_schema.' })
})

test('branching takes the first matching rule, then else', async () => {
  const wf: Workflow = {
    start: 'lookup',
    steps: {
      lookup: {
        kind: 'tool',
        tool: 'orders.get',
        args: {},
        next: { when: [{ field: 'order.total', is: { gt: 100 }, goto: 'big' }, { field: 'order.total', is: { gt: 10 }, goto: 'mid' }], else: 'small' },
      },
      big: { kind: 'approval', reason: 'big' },
      mid: { kind: 'approval', reason: 'mid' },
      small: { kind: 'approval', reason: 'small' },
    },
  }
  for (const [total, step] of [[500, 'step:big'], [50, 'step:mid'], [5, 'step:small']] as const) {
    const { store, deps } = await start(wf, { tools: fakeTools({ 'orders.get': { content: JSON.stringify({ order: { total } }) } }) })
    await advance('r1', deps)
    expect(projectRun(await store.readEvents('r1'), '').awaitingApproval).toEqual([step])
  }
})

test('a subrun step starts a child run, sleeps until it ends, then continues with its status and text', async () => {
  const children = new Map<string, { status: RunStatus; text: string | null }>()
  const started: Parameters<SubrunPort['start']>[0][] = []
  const subruns: SubrunPort = {
    async start(r) {
      started.push(r)
      const id = `child_${r.parent.stepId}`
      if (!children.has(id)) children.set(id, { status: 'running', text: null })
      return id
    },
    async status(id) {
      return children.get(id) ?? null
    },
  }
  const wf: Workflow = {
    start: 'lookup',
    steps: {
      lookup: { kind: 'tool', tool: 'orders.get', args: {}, next: 'ask' },
      ask: { kind: 'subrun', agent: 'writer', input: { $ref: 'lookup.id' } },
    },
  }
  const { store, deps } = await start(wf, { subruns })
  expect(await advance('r1', deps)).toBe('sleeping')
  expect(started[0]).toEqual({ agentId: 'writer', input: '1042', parent: { runId: 'r1', stepId: 'ask' } })
  expect((await store.readEvents('r1')).at(-1)!.payload).toEqual({ from: 'running', to: 'sleeping', reason: 'subrun' })

  expect(await advance('r1', deps)).toBe('sleeping')
  children.set('child_ask', { status: 'completed', text: 'Dear customer' })
  expect(await advance('r1', deps)).toBe('completed')
  expect(completed(await store.readEvents('r1')).at(-1)).toEqual(['ask', { status: 'completed', text: 'Dear customer' }])
})

test('a run without a workflow is an agent run', async () => {
  const store = new MemoryRunStore()
  await store.append('r1', [{ type: 'run.created', payload: { agentId: 'ops', input: { text: 'hi' } }, labels: ['untrusted'] }])
  const llm: LLMPort = {
    complete: async () => ({ message: { role: 'assistant', content: 'hello' }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end' }),
  }
  const deps = { store, llm, tools: fakeTools(), content: new MemoryContentStore(), agent: AGENT, toolsByName: TOOLS, agentVersion: 1, tenantCostToday: async () => 0 }
  expect(await advance('r1', deps)).toBe('completed')
  expect(projectRun(await store.readEvents('r1'), '').output).toBe('hello')
})

test('a workflow run stops at the llm_calls limit before its next step', async () => {
  const llm: LLMPort = {
    complete: async () => ({ message: { role: 'assistant', content: 'x' }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end' }),
  }
  const wf: Workflow = { start: 'a', steps: { a: { kind: 'llm', prompt: 'p', next: 'b' }, b: { kind: 'llm', prompt: 'p' } } }
  const { store, deps } = await start(wf, { llm, agent: { ...AGENT, limits: { llm_calls: 1 } } })
  expect(await advance('r1', deps)).toBe('waiting_human')
  const log = await store.readEvents('r1')
  expect(log.at(-2)!.payload).toMatchObject({ limit: 'llm_calls' })
  expect(completed(log).map(([id]) => id)).toEqual(['a'])
})

test('a rejected approval step whose next is a plain step id ends the run there', async () => {
  const tools = fakeTools()
  const wf: Workflow = { start: 'check', steps: { check: { kind: 'approval', reason: 'Refund?', next: 'refund' }, refund: REFUND.steps.refund! } }
  const { store, deps } = await start({ ...wf, steps: { ...wf.steps, refund: { kind: 'tool', tool: 'payments.refund', args: { order_id: '1042', amount: 1 } } } }, { tools })
  await advance('r1', deps)
  await store.append('r1', approve('step:check', 'reject'))
  expect(await advance('r1', deps)).toBe('completed')
  expect(tools.calls).toEqual([])
})

function fakeSubruns(child: { status: RunStatus; text: string | null } | (() => never)) {
  const started: Parameters<SubrunPort['start']>[0][] = []
  const subruns: SubrunPort & { started: typeof started } = {
    started,
    async start(r) {
      started.push(r)
      return 'child'
    },
    async status() {
      return typeof child === 'function' ? child() : child
    },
  }
  return subruns
}
const subrunThen = (next: Workflow['steps'][string]['next']): Workflow => ({
  start: 'ask',
  steps: { ask: { kind: 'subrun', agent: 'writer', input: 'x', ...(next === undefined ? {} : { next }) }, done: { kind: 'approval', reason: 'r' } },
})

test('a child run that did not complete fails the parent unless the step branches on it', async () => {
  const failedChild = fakeSubruns({ status: 'failed', text: null })
  const plain = await start(subrunThen('done'), { subruns: failedChild })
  await advance('r1', plain.deps)
  expect(await advance('r1', plain.deps)).toBe('failed')
  expect((await plain.store.readEvents('r1')).at(-2)!.payload).toMatchObject({ message: 'Step "ask": the child run ended failed.' })

  const branching = await start(subrunThen({ when: [{ field: 'status', is: { eq: 'failed' }, goto: 'done' }] }), { subruns: failedChild })
  await advance('r1', branching.deps)
  expect(await advance('r1', branching.deps)).toBe('waiting_human')
})

test('a subrun port error while the parent sleeps keeps it sleeping', async () => {
  const subruns = fakeSubruns(() => {
    throw new Error('connection reset')
  })
  const { deps } = await start(subrunThen(undefined), { subruns })
  expect(await advance('r1', deps)).toBe('sleeping')
  expect(await advance('r1', deps)).toBe('sleeping')
})

test("a child run gets the parent's principal", async () => {
  const subruns = fakeSubruns({ status: 'running', text: null })
  const store = new MemoryRunStore()
  await store.append('r1', [
    {
      type: 'run.created',
      payload: { agentId: 'ops', input: { text: 'x' }, principal: { id: 'cus_1', roles: ['customer'] }, workflow: { name: 'w', definition: subrunThen(undefined) } },
      labels: ['untrusted'],
    },
  ])
  const deps = { store, llm: noLlm, tools: fakeTools(), content: new MemoryContentStore(), agent: AGENT, toolsByName: TOOLS, agentVersion: 1, tenantCostToday: async () => 0, subruns }
  await advance('r1', deps)
  expect(subruns.started[0]!.principal).toEqual({ id: 'cus_1', roles: ['customer'] })
})

test('an aborted LLM call leaves no error and no state change', async () => {
  let calls = 0
  const llm: LLMPort = {
    complete: (req) =>
      new Promise((resolve, reject) => {
        if (calls++ > 0 || req.signal === undefined) {
          resolve({ message: { role: 'assistant', content: 'hello' }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end' })
          return
        }
        req.signal.addEventListener('abort', () => reject(new Error('aborted')))
      }),
  }
  const { store, deps } = await start({ start: 's', steps: { s: { kind: 'llm', prompt: 'p' } } }, { llm })
  const ctl = new AbortController()
  const pending = advance('r1', { ...deps, signal: ctl.signal })
  await new Promise((r) => setTimeout(r, 10))
  ctl.abort()
  expect(await pending).toBe('running')
  const log = await store.readEvents('r1')
  expect(log.at(-1)!.type).toBe('llm.requested')
  expect(log.map((e) => e.type)).not.toContain('error.raised')
  expect(await advance('r1', { ...deps, signal: new AbortController().signal })).toBe('completed')
})

test('an llm step writes the context of its request, with the output schema when it has one', async () => {
  const sent: { role: string; content: string }[][] = []
  const llm: LLMPort = {
    complete: async (req) => {
      sent.push(req.messages)
      return { message: { role: 'assistant', content: '{"ok":true}' }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end' }
    },
  }
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
  const { store, deps } = await start({ start: 's', steps: { s: { kind: 'llm', prompt: 'say hi', output_schema: schema } } }, { llm })
  expect(await advance('r1', deps)).toBe('completed')
  const requested = (await store.readEvents('r1')).find((e) => e.type === 'llm.requested')!
  const ctx = (requested.payload as { context?: { snapshot: string; chars: number } }).context!
  const manifest = JSON.parse((await deps.content.get([ctx.snapshot])).get(ctx.snapshot)!) as {
    messages: (string | { inline: string })[]
    tools: string[]
    output?: unknown
  }
  expect(manifest.tools).toEqual([])
  expect(manifest.output).toEqual({ name: 'step_s', schema })
  const hashes = manifest.messages.filter((x): x is string => typeof x === 'string')
  const texts = await deps.content.get(hashes)
  const contents = manifest.messages.map((x) => (JSON.parse(typeof x === 'string' ? texts.get(x)! : x.inline) as { content: string }).content)
  expect(contents).toEqual(sent[0]!.map((m) => m.content))
  expect(ctx.chars).toBe(sent[0]!.reduce((n, m) => n + m.content.length, 0))
})

test('a tool step whose output was offloaded gets the preview as its step output, and a $ref into it has no value', async () => {
  const rows = Array.from({ length: 1_000 }, (_, i) => ({ id: i, note: 'some note' }))
  const big = JSON.stringify({ rows })
  expect(big.length).toBeGreaterThan(20_000)
  const wf: Workflow = {
    start: 'lookup',
    steps: {
      lookup: { kind: 'tool', tool: 'orders.get', args: {}, next: 'use' },
      use: { kind: 'tool', tool: 'orders.get', args: { first: { $ref: 'lookup.rows' } } },
    },
  }
  const { store, deps } = await start(wf, { tools: fakeTools({ 'orders.get': { content: big } }) })
  expect(await advance('r1', deps)).toBe('failed')
  const log = await store.readEvents('r1')
  const responded = log.find((e) => e.type === 'tool.responded')!
  expect(responded.payload).toHaveProperty('offload')
  const [[, output]] = completed(log)
  expect(output).toBe((responded.payload as { content: string }).content)
  expect(String(output).length).toBeLessThan(2_100)
  expect(log.some((e) => e.type === 'error.raised' && e.payload.message.includes('has no value'))).toBe(true)
})
