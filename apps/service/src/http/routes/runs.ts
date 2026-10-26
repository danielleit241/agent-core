import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { createSecretMatcher, projectRun, resolveLimits, screenContent, screenedToolResponse, verifyChain } from '@agent-core/core'
import type { Limits, NewEvent, Offload, RunStatus, SecretBox, StoredEvent, WaitingReason } from '@agent-core/core'
import { ConfigRepo, PgContentStore, PgRunStore, StateConflictError, childRunIds, createRunWithEvent, getRun, getRunHead, makeDue } from '@agent-core/store-postgres'
import type { createPool } from '@agent-core/store-postgres'
import { ApiError, apiError, validationError } from '../errors'
import { DEFAULT_AGENT, resolveAgent } from '../../default-agent'
import { knownSecretValues } from '../../runs/known-secrets'
import { getLlmCall, getLlmCalls, getRunView } from '../../runs/views'
import { metrics } from '../../metrics'
import { keyReused, readIdempotencyKey, requestHash } from '../idempotency'

const POLL_MS = 100

const RunBody = z.object({
  /** Without it the run uses the built-in default agent. */
  agent: z.string().min(1).optional(),
  /** A workflow of the agent; without it the run is an agent run. */
  workflow: z.string().min(1).optional(),
  input: z.object({ text: z.string().min(1) }),
  // Bounded: the principal goes into the LLM context.
  principal: z.object({ id: z.string().max(200), roles: z.array(z.string().max(64)).max(20) }).optional(),
})
const ACTIONS = ['approve', 'reject', 'outcome_happened', 'outcome_not_happened', 'continue', 'answer', 'cancel'] as const
type Action = (typeof ACTIONS)[number]
/** Everything a human sends to a run. `message` steers it; the other actions answer a wait or cancel it. */
const InputBody = z.union([
  z.object({ action: z.enum(ACTIONS).exclude(['answer']) }).strict(),
  z.object({ action: z.literal('answer'), text: z.string().min(1).max(32_000) }).strict(),
  z.object({ action: z.literal('message'), text: z.string().min(1).max(32_000) }).strict(),
])
const ENDED: readonly RunStatus[] = ['completed', 'failed', 'cancelled']

/** The actions a human may take for each waiting reason. A reason without an entry only allows `cancel`. */
const ALLOWED: Partial<Record<WaitingReason, readonly Action[]>> = {
  approval: ['approve', 'reject', 'cancel'],
  unknown_outcome: ['outcome_happened', 'outcome_not_happened', 'cancel'],
  limit: ['continue', 'cancel'],
  breaker: ['continue', 'cancel'],
  input: ['answer', 'cancel'],
  escalated: ['answer', 'cancel'],
}
const allowedFor = (reason: WaitingReason | null): readonly Action[] => (reason && ALLOWED[reason]) || ['cancel']

const HAPPENED_TEXT = 'A human confirmed that this action happened. Its result is not available.'

const notCancellable = (fix: string) => apiError('run_not_cancellable', 'The run cannot be cancelled in its current state.', fix, 409)
const runEnded = () => apiError('run_ended', 'The run has ended and takes no more input.', 'Start a new run with POST /v1/runs.', 409)

export const runNotFound = (id: string) =>
  apiError('run_not_found', `Run "${id}" does not exist.`, 'Check the run id returned by POST /v1/runs.', 404)

/** Parses `wait` as `N` or `Ns`, 1 to 30. Returns seconds, or undefined when absent. */
function parseWait(raw: unknown): number | undefined {
  if (raw === undefined) return undefined
  const m = typeof raw === 'string' ? /^(\d+)s?$/.exec(raw) : null
  const seconds = m ? Number(m[1]) : NaN
  if (!(seconds >= 1 && seconds <= 30)) {
    throw apiError('invalid_request', 'Query "wait" must be N or Ns, from 1 to 30.', 'Use for example ?wait=10 or ?wait=10s.', 400)
  }
  return seconds
}

/**
 * Verifies the hash chain, then that the events reach the head stored on the run, which catches deleted tail events.
 * `head` must be read before `allEvents`; events appended after the head was read (seq above its lastSeq) are ignored.
 */
export function checkChain(
  allEvents: StoredEvent[],
  head: { lastSeq: number | null; lastHash: string | null } | null,
): { valid: true } | { valid: false; brokenAtSeq: number } {
  const events = allEvents.filter((e) => e.seq <= (head?.lastSeq ?? 0))
  const chain = verifyChain(events)
  if (!chain.valid) return chain
  const lastStored = events.at(-1)
  const storedSeq = lastStored?.seq ?? 0
  const headSeq = head?.lastSeq ?? 0
  if (storedSeq !== headSeq) return { valid: false, brokenAtSeq: Math.min(storedSeq, headSeq) + 1 }
  if (lastStored && lastStored.hash !== head?.lastHash) return { valid: false, brokenAtSeq: lastStored.seq }
  return { valid: true }
}

export function registerRunRoutes(app: FastifyInstance, deps: { pool: ReturnType<typeof createPool>; secrets: SecretBox; closing: AbortSignal; llmConfigured: boolean; llmApiKey?: string }): void {
  const { pool } = deps
  const configFor = (req: FastifyRequest) => new ConfigRepo(pool, req.auth.tenantId, deps.secrets)
  const storeFor = (req: FastifyRequest) => new PgRunStore(pool, req.auth.tenantId)

  /** The matcher for text a caller sent: the secrets the service holds for the agent, and the ones that look like secrets. */
  async function secretsFor(req: FastifyRequest, agent: { connections: string[] }) {
    return createSecretMatcher(await knownSecretValues(configFor(req), agent, deps.llmApiKey))
  }

  /** Text longer than the agent's `tool_output_chars` is offloaded: stored whole, and its preview is what the run sees. */
  const offloadFor = (req: FastifyRequest, agent: { limits?: Partial<Limits> }) => ({
    store: new PgContentStore(pool, req.auth.tenantId),
    atChars: resolveLimits(agent.limits).tool_output_chars,
  })

  /**
   * Screens a run input or a message. The caller counts the redactions in the metrics once the event is stored.
   * `offload: false` keeps the text whole, for the input of a workflow run (`$input.text` must stay exact).
   */
  async function screenInput(
    req: FastifyRequest,
    agent: { connections: string[]; limits?: Partial<Limits> },
    text: string,
    offload = true,
  ): Promise<{ text: string; redactions?: Record<string, number>; offload?: Offload }> {
    const screened = await screenContent(text, { secrets: await secretsFor(req, agent), ...(offload ? { offload: offloadFor(req, agent) } : {}) })
    return {
      text: screened.content,
      ...(Object.keys(screened.redactions).length === 0 ? {} : { redactions: screened.redactions }),
      ...(screened.offload === undefined ? {} : { offload: screened.offload }),
    }
  }

  /** Polls until the run settles, the time runs out, the client disconnects or the app closes. */
  async function waitForSettle(tenantId: string, runId: string, seconds: number, clientGone: () => boolean): Promise<void> {
    const deadline = Date.now() + seconds * 1000
    for (;;) {
      const run = await getRun(pool, tenantId, runId)
      if (!run || (run.status !== 'queued' && run.status !== 'running') || Date.now() >= deadline) return
      if (clientGone() || deps.closing.aborted) return
      await new Promise((r) => setTimeout(r, POLL_MS))
    }
  }

  app.post<{ Querystring: { wait?: string } }>('/v1/runs', async (req, reply) => {
    const { tenantId } = req.auth
    if (!deps.llmConfigured) {
      throw apiError('llm_not_configured', 'The LLM is not configured, so no run can start.', 'Set LLM_BASE_URL and LLM_MODEL_DEFAULT, then restart.', 503)
    }
    const config = configFor(req)
    const wait = parseWait(req.query.wait)
    const key = readIdempotencyKey(req)
    if (key?.startsWith('subrun:')) {
      throw apiError(
        'invalid_idempotency_key',
        'An Idempotency-Key may not start with "subrun:".',
        'That prefix names the child runs of workflow steps. Use another key.',
        400,
      )
    }
    const parsed = RunBody.safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error)
    const body = parsed.data
    if (body.agent === undefined && body.workflow !== undefined) {
      throw apiError('agent_required', 'A workflow run needs an agent.', 'Add "agent" with the agent that defines the workflow.', 422)
    }
    const agentId = body.agent ?? DEFAULT_AGENT.id
    const agent = await resolveAgent(config, agentId)
    if (!agent) {
      throw apiError(
        'unknown_agent',
        `Agent "${agentId}" does not exist.`,
        'Create the agent with POST /v1/agents first.',
        422,
      )
    }
    const workflows = agent.definition.workflows ?? {}
    // Own keys only: a name like "constructor" must not find an inherited member.
    const definition = body.workflow !== undefined && Object.hasOwn(workflows, body.workflow) ? workflows[body.workflow] : undefined
    if (body.workflow !== undefined && definition === undefined) {
      throw apiError(
        'unknown_workflow',
        `Agent "${agentId}" has no workflow "${body.workflow}".`,
        "Name a workflow from the agent's \"workflows\", or leave \"workflow\" out for an agent run.",
        422,
      )
    }
    const input = await screenInput(req, agent.definition, body.input.text, definition === undefined)
    // One transaction: the run row, run.created and the queue row appear together or not at all.
    const created = await createRunWithEvent(pool, {
      tenantId,
      runId: `run_${randomUUID()}`,
      agentId,
      agentVersion: agent.version,
      idempotencyKey: key,
      requestHash: key === undefined ? undefined : requestHash(req),
      created: {
        type: 'run.created',
        payload: {
          agentId,
          input: { text: input.text, ...(input.redactions === undefined ? {} : { redactions: input.redactions }), ...(input.offload === undefined ? {} : { offload: input.offload }) },
          ...(body.principal ? { principal: body.principal } : {}),
          ...(definition === undefined ? {} : { workflow: { name: body.workflow!, definition } }),
        },
        labels: ['untrusted'], // the caller's text is untrusted input
      },
    })
    if (created.created && input.redactions !== undefined) metrics.redacted(input.redactions)
    if (!created.created) {
      // A row from before the hash existed has none and matches any request.
      if (created.requestHash !== null && created.requestHash !== requestHash(req)) throw keyReused()
      void reply.header('Idempotent-Replayed', 'true')
    }
    if (wait !== undefined) {
      let gone = false
      reply.raw.on('close', () => {
        gone = true
      })
      await waitForSettle(tenantId, created.id, wait, () => gone)
      return reply.code(200).send(await getRunView(pool, tenantId, created.id))
    }
    const run = await getRun(pool, tenantId, created.id)
    return reply.code(202).send({ run_id: created.id, status: run?.status ?? 'queued' })
  })

  app.get<{ Params: { id: string } }>('/v1/runs/:id', async (req) => {
    const view = await getRunView(pool, req.auth.tenantId, req.params.id)
    if (!view) throw runNotFound(req.params.id)
    return view
  })

  app.get<{ Params: { id: string } }>('/v1/runs/:id/events', async (req) => {
    const { tenantId } = req.auth
    if (!(await getRun(pool, tenantId, req.params.id))) throw runNotFound(req.params.id)
    // Head first: a run that is active appends between the two reads, and checkChain ignores those events.
    const head = await getRunHead(pool, tenantId, req.params.id)
    const events = await storeFor(req).readEvents(req.params.id)
    const chain = checkChain(events, head)
    return {
      events,
      chain: chain.valid ? { valid: true } : { valid: false, broken_at_seq: chain.brokenAtSeq },
      head: { last_seq: head?.lastSeq ?? null, last_hash: head?.lastHash ?? null },
    }
  })

  app.get<{ Params: { id: string } }>('/v1/runs/:id/llm-calls', async (req) => {
    const view = await getLlmCalls(pool, req.auth.tenantId, req.params.id)
    if (!view) throw runNotFound(req.params.id)
    return view
  })

  app.get<{ Params: { id: string; seq: string } }>('/v1/runs/:id/llm-calls/:seq', async (req) => {
    const { id, seq } = req.params
    if (!(await getRun(pool, req.auth.tenantId, id))) throw runNotFound(id)
    const call = /^\d+$/.test(seq) ? await getLlmCall(pool, req.auth.tenantId, id, Number(seq)) : null
    if (!call) {
      throw apiError('llm_call_not_found', `Run "${id}" has no LLM call with a snapshot at seq ${seq}.`, 'List the calls with GET /v1/runs/{id}/llm-calls and use a seq with parts above 0.', 404)
    }
    return call
  })

  /** The full text of an offloaded content of the run: its input, a message, a tool result. Only handles of this run. */
  app.get<{ Params: { id: string; handle: string } }>('/v1/runs/:id/outputs/:handle', async (req, reply) => {
    const { id, handle } = req.params
    if (!(await getRun(pool, req.auth.tenantId, id))) throw runNotFound(id)
    const entry = projectRun(await storeFor(req).readEvents(id), '').handles.get(handle)
    const text = entry === undefined ? undefined : (await new PgContentStore(pool, req.auth.tenantId).get([entry.hash])).get(entry.hash)
    if (text === undefined) {
      throw apiError('output_not_found', `Run "${id}" has no output with handle "${handle}".`, 'Use a handle named in a preview of this run, for example in its events.', 404)
    }
    return reply.type('text/plain; charset=utf-8').send(text)
  })

  /**
   * A run that is not running is cancelled at once. A running run gets a cancel input and its job is made due:
   * the runner stops it before its next step, so a tool call in flight still finishes.
   */
  async function cancelRun(req: FastifyRequest, runId: string, firstStatus: RunStatus): Promise<{ run_id: string; status: RunStatus }> {
    const store = storeFor(req)
    let status = firstStatus
    // One retry: the run may move on meanwhile (a worker starts it, or a human resumes it); a cancel still applies.
    for (let attempt = 0; ; attempt++) {
      if (ENDED.includes(status)) throw notCancellable('The run has already ended.')
      try {
        if (status === 'running') {
          await store.append(runId, [{ type: 'input.received', payload: { action: 'cancel' }, labels: [] }], { expect: { status: 'running' } })
          await makeDue(pool, req.auth.tenantId, runId)
          return { run_id: runId, status: 'running' }
        }
        await store.append(runId, [{ type: 'run.state_changed', payload: { from: status, to: 'cancelled' }, labels: [] }], { expect: { status } })
        return { run_id: runId, status: 'cancelled' }
      } catch (err) {
        if (!(err instanceof StateConflictError)) throw err
        if (attempt > 0) {
          throw notCancellable('The run changed state while cancelling. Check GET /v1/runs/{id} and retry.')
        }
        status = (await getRun(pool, req.auth.tenantId, runId))?.status ?? status
      }
    }
  }

  /** Cancels the child runs of a workflow's subrun steps, and theirs: work the caller cancelled must not go on. */
  async function cancelChildren(req: FastifyRequest, runId: string): Promise<void> {
    for (const childId of await childRunIds(pool, req.auth.tenantId, runId)) {
      const child = await getRun(pool, req.auth.tenantId, childId)
      if (!child || ENDED.includes(child.status)) continue
      try {
        await cancelRun(req, childId, child.status)
      } catch (err) {
        // The child ended meanwhile; nothing left to stop.
        if (!(err instanceof ApiError) || err.status !== 409) throw err
      }
      await cancelChildren(req, childId)
    }
  }

  /** Records a message for the run. The runner adds it to the context before its next LLM call; the run's state does not change. */
  async function sendMessage(req: FastifyRequest, runId: string, firstStatus: RunStatus, agentId: string, rawText: string): Promise<{ run_id: string; status: RunStatus }> {
    const store = storeFor(req)
    // A run whose agent was deleted has no connections to look up; the patterns still apply.
    const agent = await resolveAgent(configFor(req), agentId)
    const { text, redactions, offload } = await screenInput(req, agent?.definition ?? { connections: [] }, rawText)
    let status = firstStatus
    // One retry: the run may move between states (for example queued to running) while the message is sent.
    for (let attempt = 0; ; attempt++) {
      if (ENDED.includes(status)) throw runEnded()
      try {
        await store.append(runId, [{ type: 'input.received', payload: { action: 'message', text, ...(redactions === undefined ? {} : { redactions }), ...(offload === undefined ? {} : { offload }) }, labels: ['untrusted'] }], {
          expect: { status },
        })
        if (redactions !== undefined) metrics.redacted(redactions)
        return { run_id: runId, status }
      } catch (err) {
        if (!(err instanceof StateConflictError) || attempt > 0) throw err
        status = (await getRun(pool, req.auth.tenantId, runId))?.status ?? status
      }
    }
  }

  app.post<{ Params: { id: string } }>('/v1/runs/:id/input', { config: { idempotent: true } }, async (req, reply) => {
    const parsed = InputBody.safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error)
    const body = parsed.data
    const runId = req.params.id
    const store = storeFor(req)
    const run = await getRun(pool, req.auth.tenantId, runId)
    if (!run) throw runNotFound(runId)
    if (body.action === 'cancel') {
      const cancelled = await cancelRun(req, runId, run.status)
      await cancelChildren(req, runId)
      return reply.code(202).send(cancelled)
    }
    if (body.action === 'message') return reply.code(202).send(await sendMessage(req, runId, run.status, run.agentId, body.text))
    const { action } = body
    // approve and reject keep their original error code for a run that is not waiting.
    const notWaiting =
      action === 'approve' || action === 'reject'
        ? apiError(
            'not_waiting_for_approval',
            'The run is not waiting for an approval.',
            'Only a run with status "waiting_human" and waiting_reason "approval" can be resolved.',
            409,
          )
        : apiError(
            'not_waiting_human',
            'The run is not waiting for a human.',
            'Only a run with status "waiting_human" can be resolved. Check GET /v1/runs/{id}.',
            409,
          )
    // One read of the log: the checks, the events to write and the log head all come from it.
    const logged = await store.readEvents(runId)
    const proj = projectRun(logged, '')
    if (proj.status !== 'waiting_human') throw notWaiting
    const allowed = allowedFor(proj.waitingReason)
    if (!allowed.includes(action)) {
      throw apiError(
        'action_not_allowed',
        `The action "${action}" does not fit a run waiting for "${proj.waitingReason}".`,
        `Use one of: ${allowed.join(', ')}.`,
        409,
      )
    }
    const stateTo = (to: 'running'): NewEvent => ({
      type: 'run.state_changed',
      payload: { from: 'waiting_human', to },
      labels: [],
    })
    let events: NewEvent[]
    let answerRedactions: Record<string, number> | undefined
    if (action === 'continue') {
      // A legacy `breaker` wait has no limit.reached event; it was an llm_calls breach.
      const breached = logged.findLast((e) => e.type === 'limit.reached')
      const limit = proj.waitingReason === 'breaker' || breached?.type !== 'limit.reached' ? 'llm_calls' : breached.payload.limit
      // The tenant's daily cost is an admin budget: a tenant key may not spend past it.
      if (limit === 'tenant_cost_usd_per_day' && !req.auth.admin) {
        throw apiError(
          'limit_needs_admin',
          'Only the admin key may let a run go past the tenant daily cost.',
          'Ask an admin to continue the run, or cancel it.',
          403,
        )
      }
      events = [{ type: 'limit.continued', payload: { limit }, labels: ['trusted'] }, stateTo('running')]
    } else if (action === 'approve' || action === 'reject') {
      events = [
        ...proj.awaitingApproval.map(
          (toolCallId): NewEvent => ({ type: 'approval.resolved', payload: { toolCallId, action }, labels: ['trusted'] }),
        ),
        stateTo('running'),
      ]
    } else if (body.action === 'answer') {
      // `ask_human` and `escalate` stay in flight until now; the answer is their result.
      const toolCallId = proj.inFlight[0]
      if (toolCallId === undefined) throw notWaiting
      const agent = await resolveAgent(configFor(req), run.agentId)
      const secrets = await secretsFor(req, agent?.definition ?? { connections: [] })
      const response = await screenedToolResponse({ toolCallId }, { content: body.text, isError: false }, ['untrusted'], {
        secrets,
        offload: offloadFor(req, agent?.definition ?? {}),
      })
      answerRedactions = response.payload.redactions
      events = [response, stateTo('running')]
    } else {
      const toolCallId = proj.inFlight[0]
      if (toolCallId === undefined) throw notWaiting
      const happened = action === 'outcome_happened'
      events = [
        { type: 'outcome.settled', payload: { toolCallId, outcome: happened ? 'happened' : 'not_happened' }, labels: ['trusted'] },
        ...(happened
          ? [{ type: 'tool.responded', payload: { toolCallId, content: HAPPENED_TEXT, isError: false }, labels: ['trusted'] } satisfies NewEvent]
          : []),
        stateTo('running'),
      ]
    }
    try {
      // The expectation is checked under the row lock, so two concurrent resolves cannot both write.
      await store.append(runId, events, { expect: { status: 'waiting_human', waitingReason: proj.waitingReason ?? undefined, lastSeq: logged.at(-1)!.seq }, enqueue: true })
    } catch (err) {
      if (err instanceof StateConflictError) throw notWaiting
      throw err
    }
    if (answerRedactions !== undefined) metrics.redacted(answerRedactions)
    return reply.code(202).send({ run_id: runId, status: 'queued' })
  })

}
