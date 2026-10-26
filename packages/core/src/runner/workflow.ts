import { z } from 'zod'
import { projectRun, type RunProjection } from '../events/projection'
import { conditionHolds } from '../policy/rules'
import type { Label, NewEvent, RunStatus, StoredEvent, ToolCall, Workflow } from '../types'
import {
  advanceRun,
  checkRunLimits,
  errorMessage,
  expiresAt,
  handleToolCall,
  limitReached,
  llmRetryAt,
  nowOf,
  stateChanged,
  waitHuman,
  type RunnerDeps,
} from './runner'

const ENDED: readonly RunStatus[] = ['completed', 'failed', 'cancelled']

/** Where a workflow run is: the current step (null when the workflow is done), and the outputs so far. */
export type WorkflowProjection = { current: string | null; started: boolean; outputs: Map<string, unknown>; last: unknown }

/** The value at a dotted path of an output; `present` is false when the path does not exist. */
function valueAt(output: unknown, path: string[]): { present: boolean; value: unknown } {
  let value = output
  for (const key of path) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return { present: false, value: undefined }
    value = (value as Record<string, unknown>)[key]
  }
  return { present: true, value }
}

/** The step after `id`, given its output: the first `when` rule that holds, else `else`, else the end. */
export function nextStep(wf: Workflow, id: string, output: unknown): string | null {
  const next = wf.steps[id]?.next
  if (next === undefined) return null
  if (typeof next === 'string') return next
  for (const rule of next.when) {
    const { present, value } = valueAt(output, rule.field.split('.'))
    if (conditionHolds(present ? { v: value } : {}, 'v', rule.is)) return rule.goto
  }
  return next.else ?? null
}

/** Recomputes the workflow position from the event log. */
export function projectWorkflow(events: StoredEvent[], wf: Workflow): WorkflowProjection {
  let current: string | null = wf.start
  let started = false
  let last: unknown = undefined
  const outputs = new Map<string, unknown>()
  for (const e of events) {
    if (e.type === 'step.started' && e.payload.stepId === current) started = true
    if (e.type === 'step.completed' && e.payload.stepId === current) {
      outputs.set(current, e.payload.output)
      last = e.payload.output
      current = nextStep(wf, current, e.payload.output)
      started = false
    }
  }
  return { current, started, outputs, last }
}

class RefError extends Error {
  constructor(readonly ref: string) {
    super(`$ref ${ref} has no value`)
  }
}

/** Replaces each `{ "$ref": ... }` in a value with the run input or an earlier step's output. */
function resolve(value: unknown, input: string, outputs: Map<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((v) => resolve(v, input, outputs))
  if (value === null || typeof value !== 'object') return value
  const ref = (value as { $ref?: unknown }).$ref
  if (typeof ref === 'string') {
    if (ref === '$input.text') return input
    const [stepId, ...path] = ref.split('.')
    const found = outputs.has(stepId!) ? valueAt(outputs.get(stepId!), path) : { present: false, value: undefined }
    if (!found.present) throw new RefError(ref)
    return found.value
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, input, outputs)]))
}

/** Tool output as JSON when it parses, else `{ text }`. */
function parseOutput(content: string): unknown {
  try {
    return JSON.parse(content) as unknown
  } catch {
    return { text: content }
  }
}

const stepCompleted = (stepId: string, output: unknown, label: Label): NewEvent => ({
  type: 'step.completed',
  payload: { stepId, output: output as z.infer<ReturnType<typeof z.json>> },
  labels: [label],
})

/** Runs a run with the runner its `run.created` names: a workflow run, or else an agent run. */
export async function advance(runId: string, deps: RunnerDeps): Promise<RunStatus> {
  const first = (await deps.store.readEvents(runId))[0]
  const workflow = first?.type === 'run.created' ? first.payload.workflow : undefined
  return workflow === undefined ? advanceRun(runId, deps) : advanceWorkflow(runId, deps, workflow.definition)
}

/**
 * Advances a workflow run step by step until it completes, fails, waits for a human or sleeps on a child run.
 * Like `advanceRun`, state is recomputed from the log before every step, so a crash loses at most one step.
 * Tool steps go through the same rule gate, approval and retries as an agent's tool calls, with the id `step:<stepId>`.
 */
export async function advanceWorkflow(runId: string, deps: RunnerDeps, wf: Workflow): Promise<RunStatus> {
  const fail = async (message: string): Promise<RunStatus> => {
    await deps.store.append(runId, [
      { type: 'error.raised', payload: { message, retryable: false }, labels: [] },
      stateChanged('running', 'failed'),
    ])
    return 'failed'
  }
  for (;;) {
    const events = await deps.store.readEvents(runId)
    const proj = projectRun(events, deps.agent.instructions)
    if (deps.signal?.aborted) return proj.status
    if (proj.status === 'queued') {
      await deps.store.append(runId, [stateChanged('queued', 'running')])
      continue
    }
    const flow = projectWorkflow(events, wf)
    const id = flow.current
    const step = id === null ? undefined : wf.steps[id]
    const input = events[0]?.type === 'run.created' ? events[0].payload.input.text : ''
    if (proj.status === 'sleeping') {
      // Only a subrun step sleeps; it wakes when its child run has ended.
      if (id === null || step?.kind !== 'subrun' || deps.subruns === undefined) return 'sleeping'
      const child = await deps.subruns.status(await startChild(runId, deps, id, step.agent, step.input, input, flow))
      if (child === null || !ENDED.includes(child.status)) return 'sleeping'
      await deps.store.append(runId, [stepCompleted(id, { status: child.status, text: child.text }, 'untrusted'), stateChanged('sleeping', 'running')])
      continue
    }
    if (proj.status !== 'running') return proj.status
    if (proj.cancelRequested) {
      await deps.store.append(runId, [stateChanged('running', 'cancelled', 'cancelled')])
      return 'cancelled'
    }
    if (id === null) {
      await deps.store.append(runId, [stateChanged('running', 'completed')])
      return 'completed'
    }
    if (step === undefined) return fail(`Step "${id}" does not exist.`)
    if (!flow.started) {
      const b = await checkRunLimits(deps, proj, undefined)
      if (b !== null) {
        await deps.store.append(runId, [limitReached(b), waitHuman('running', 'limit', expiresAt(deps))])
        return 'waiting_human'
      }
      await deps.store.append(runId, [{ type: 'step.started', payload: { stepId: id, kind: step.kind }, labels: [] }])
      continue
    }
    let outcome: RunStatus | 'continue'
    try {
      if (step.kind === 'tool') outcome = await toolStep(runId, deps, proj, events, id, step.tool, resolve(step.args, input, flow.outputs), fail)
      else if (step.kind === 'approval') outcome = await approvalStep(runId, deps, proj, id, step.reason)
      else if (step.kind === 'llm') outcome = await llmStep(runId, deps, proj, id, step.prompt, step.output_schema, input, flow, fail)
      else {
        if (deps.subruns === undefined) return fail(`Step "${id}": subruns are not available.`)
        await startChild(runId, deps, id, step.agent, step.input, input, flow)
        await deps.store.append(runId, [stateChanged('running', 'sleeping', 'subrun')])
        outcome = 'sleeping'
      }
    } catch (err) {
      if (err instanceof RefError) return fail(`Step "${id}": $ref "${err.ref}" has no value.`)
      throw err
    }
    if (outcome !== 'continue') return outcome
  }
}

/** Starts the child run of a subrun step, or finds the one started before. */
async function startChild(
  runId: string,
  deps: RunnerDeps,
  stepId: string,
  agentId: string,
  stepInput: unknown,
  input: string,
  flow: WorkflowProjection,
): Promise<string> {
  const value = resolve(stepInput, input, flow.outputs)
  return deps.subruns!.start({ agentId, input: typeof value === 'string' ? value : JSON.stringify(value), parent: { runId, stepId } })
}

async function toolStep(
  runId: string,
  deps: RunnerDeps,
  proj: RunProjection,
  events: StoredEvent[],
  id: string,
  toolName: string,
  args: unknown,
  fail: (message: string) => Promise<RunStatus>,
): Promise<RunStatus | 'continue'> {
  const call: ToolCall = { id: `step:${id}`, name: toolName, arguments: args as Record<string, unknown> }
  const result = events.findLast((e) => e.type === 'tool.responded' && e.payload.toolCallId === call.id)
  if (result?.type !== 'tool.responded') return handleToolCall(runId, deps, proj, call)
  // A workflow has no model to read an error and decide: an error stops the run.
  if (result.payload.isError) return fail(`Step "${id}" failed: ${result.payload.content}`)
  const label = result.labels[0] ?? 'untrusted'
  await deps.store.append(runId, [stepCompleted(id, parseOutput(result.payload.content), label)])
  return 'continue'
}

async function approvalStep(runId: string, deps: RunnerDeps, proj: RunProjection, id: string, reason: string): Promise<RunStatus | 'continue'> {
  const callId = `step:${id}`
  const answer = proj.approvals.get(callId)
  if (answer !== undefined) {
    // A rejection is an answer, not a failure: the workflow can branch on it.
    await deps.store.append(runId, [stepCompleted(id, { approved: answer === 'approve' }, 'trusted')])
    return 'continue'
  }
  await deps.store.append(runId, [
    // Also the crash-safe path: the request was logged but the wait was not.
    ...(proj.awaitingApproval.includes(callId)
      ? []
      : [{ type: 'approval.requested' as const, payload: { toolCallId: callId, tool: 'approval', args: {}, reason }, labels: [] }]),
    waitHuman('running', 'approval', expiresAt(deps)),
  ])
  return 'waiting_human'
}

async function llmStep(
  runId: string,
  deps: RunnerDeps,
  proj: RunProjection,
  id: string,
  prompt: string,
  outputSchema: Record<string, unknown> | undefined,
  input: string,
  flow: WorkflowProjection,
  fail: (message: string) => Promise<RunStatus>,
): Promise<RunStatus | 'continue'> {
  const now = nowOf(deps)
  // The run waits for an LLM retry; the worker calls again once `retryAt` has passed.
  if (proj.llmRetry.retryAt !== null && Date.parse(proj.llmRetry.retryAt) > now.getTime()) return 'running'
  await deps.store.append(runId, [{ type: 'llm.requested', payload: { model: deps.agent.model }, labels: [] }])
  const firstTurn = proj.messages.findIndex((m) => m.role !== 'system')
  const schema = outputSchema === undefined ? undefined : z.fromJSONSchema(outputSchema as Parameters<typeof z.fromJSONSchema>[0])
  let res: Awaited<ReturnType<RunnerDeps['llm']['complete']>>
  try {
    res = await deps.llm.complete({
      model: deps.agent.model,
      messages: [
        ...proj.messages.slice(0, firstTurn === -1 ? proj.messages.length : firstTurn),
        { role: 'system', content: `Current time: ${now.toISOString()}`, volatile: true },
        { role: 'user', content: input },
        ...(flow.last === undefined ? [] : [{ role: 'user' as const, content: `Output of the previous step: ${JSON.stringify(flow.last)}` }]),
        { role: 'user', content: prompt },
      ],
      tools: [],
      ...(schema === undefined ? {} : { output: { name: `step_${id}`, schema } }),
    })
  } catch (err) {
    const retryAt = llmRetryAt(err, proj, deps)
    if (retryAt !== null) {
      await deps.store.append(runId, [{ type: 'error.raised', payload: { message: errorMessage(err), retryable: true, retryAt }, labels: [] }])
      return 'running'
    }
    return fail(errorMessage(err))
  }
  const responded: NewEvent = {
    type: 'llm.responded',
    payload: { message: res.message, usage: res.usage, stopReason: res.stopReason },
    labels: [],
  }
  let output: unknown = { text: res.message.content }
  let problem: string | null = res.stopReason === 'end' ? null : `Step "${id}": the LLM did not finish (${res.stopReason}).`
  if (problem === null && schema !== undefined) {
    const parsed = schema.safeParse(parseOutput(res.message.content))
    if (parsed.success) output = parsed.data
    else problem = `Step "${id}": the LLM output does not match output_schema.`
  }
  if (problem !== null) {
    await deps.store.append(runId, [responded])
    return fail(problem)
  }
  await deps.store.append(runId, [responded, stepCompleted(id, output, 'untrusted')])
  return 'continue'
}
