import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { projectRun, verifyChain } from '@agent-core/core'
import type { NewEvent, StoredEvent, WaitingReason } from '@agent-core/core'
import { ConfigRepo, PgRunStore, StateConflictError, createRunWithEvent, getRun, getRunHead } from '@agent-core/store-postgres'
import type { createPool } from '@agent-core/store-postgres'
import { apiError, validationError } from '../errors'
import { getRunView } from '../../runs/views'
import { keyReused, readIdempotencyKey, requestHash } from '../idempotency'

const TENANT = 'default'
const POLL_MS = 100

const RunBody = z.object({
  agent: z.string().min(1),
  input: z.object({ text: z.string().min(1) }),
  // Bounded: the principal goes into the LLM context.
  principal: z.object({ id: z.string().max(200), roles: z.array(z.string().max(64)).max(20) }).optional(),
})
const ACTIONS = ['approve', 'reject', 'outcome_happened', 'outcome_not_happened', 'cancel'] as const
type Action = (typeof ACTIONS)[number]
const ResolveBody = z.object({ action: z.enum(ACTIONS) })

/** The actions a human may take for each waiting reason. A reason without an entry only allows `cancel`. */
const ALLOWED: Partial<Record<WaitingReason, readonly Action[]>> = {
  approval: ['approve', 'reject', 'cancel'],
  unknown_outcome: ['outcome_happened', 'outcome_not_happened', 'cancel'],
}
const allowedFor = (reason: WaitingReason | null): readonly Action[] => (reason && ALLOWED[reason]) || ['cancel']

const HAPPENED_TEXT = 'A human confirmed that this action happened. Its result is not available.'

const notCancellable = (fix: string) => apiError('run_not_cancellable', 'The run cannot be cancelled in its current state.', fix, 409)

const runNotFound = (id: string) =>
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

export function registerRunRoutes(app: FastifyInstance, deps: { pool: ReturnType<typeof createPool>; closing: AbortSignal }): void {
  const { pool } = deps
  const config = new ConfigRepo(pool, TENANT)
  const store = new PgRunStore(pool, TENANT)

  /** Polls until the run settles, the time runs out, the client disconnects or the app closes. */
  async function waitForSettle(runId: string, seconds: number, clientGone: () => boolean): Promise<void> {
    const deadline = Date.now() + seconds * 1000
    for (;;) {
      const run = await getRun(pool, TENANT, runId)
      if (!run || (run.status !== 'queued' && run.status !== 'running') || Date.now() >= deadline) return
      if (clientGone() || deps.closing.aborted) return
      await new Promise((r) => setTimeout(r, POLL_MS))
    }
  }

  app.post<{ Querystring: { wait?: string } }>('/v1/runs', async (req, reply) => {
    const wait = parseWait(req.query.wait)
    const key = readIdempotencyKey(req)
    const parsed = RunBody.safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error)
    const body = parsed.data
    const agent = await config.getAgent(body.agent)
    if (!agent) {
      throw apiError(
        'unknown_agent',
        `Agent "${body.agent}" does not exist.`,
        'Create the agent with POST /v1/agents first.',
        422,
      )
    }
    // One transaction: the run row, run.created and the queue row appear together or not at all.
    const created = await createRunWithEvent(pool, {
      tenantId: TENANT,
      runId: `run_${randomUUID()}`,
      agentId: body.agent,
      agentVersion: agent.version,
      idempotencyKey: key,
      requestHash: key === undefined ? undefined : requestHash(req),
      created: {
        type: 'run.created',
        payload: {
          agentId: body.agent,
          input: body.input,
          ...(body.principal ? { principal: body.principal } : {}),
        },
        labels: ['untrusted'], // the caller's text is untrusted input
      },
    })
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
      await waitForSettle(created.id, wait, () => gone)
      return reply.code(200).send(await getRunView(pool, TENANT, created.id))
    }
    const run = await getRun(pool, TENANT, created.id)
    return reply.code(202).send({ run_id: created.id, status: run?.status ?? 'queued' })
  })

  app.get<{ Params: { id: string } }>('/v1/runs/:id', async (req) => {
    const view = await getRunView(pool, TENANT, req.params.id)
    if (!view) throw runNotFound(req.params.id)
    return view
  })

  app.get<{ Params: { id: string } }>('/v1/runs/:id/events', async (req) => {
    if (!(await getRun(pool, TENANT, req.params.id))) throw runNotFound(req.params.id)
    // Head first: a run that is active appends between the two reads, and checkChain ignores those events.
    const head = await getRunHead(pool, TENANT, req.params.id)
    const events = await store.readEvents(req.params.id)
    const chain = checkChain(events, head)
    return { events, chain: chain.valid ? { valid: true } : { valid: false, broken_at_seq: chain.brokenAtSeq } }
  })

  app.post<{ Params: { id: string } }>('/v1/runs/:id/resolve', { config: { idempotent: true } }, async (req, reply) => {
    const parsed = ResolveBody.safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error)
    const { action } = parsed.data
    const runId = req.params.id
    const run = await getRun(pool, TENANT, runId)
    if (!run) throw runNotFound(runId)
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
    const stateTo = (to: 'running' | 'cancelled'): NewEvent => ({
      type: 'run.state_changed',
      payload: { from: 'waiting_human', to },
      labels: [],
    })
    let events: NewEvent[]
    let enqueue = true
    if (action === 'cancel') {
      events = [stateTo('cancelled')]
      enqueue = false
    } else if (action === 'approve' || action === 'reject') {
      events = [
        ...proj.awaitingApproval.map(
          (toolCallId): NewEvent => ({ type: 'approval.resolved', payload: { toolCallId, action }, labels: ['trusted'] }),
        ),
        stateTo('running'),
      ]
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
      await store.append(runId, events, { expect: { status: 'waiting_human', waitingReason: proj.waitingReason ?? undefined, lastSeq: logged.at(-1)!.seq }, enqueue })
    } catch (err) {
      if (err instanceof StateConflictError) throw notWaiting
      throw err
    }
    return reply.code(202).send({ run_id: runId, status: action === 'cancel' ? 'cancelled' : 'queued' })
  })

  app.post<{ Params: { id: string } }>('/v1/runs/:id/cancel', { config: { idempotent: true } }, async (req, reply) => {
    const runId = req.params.id
    const run = await getRun(pool, TENANT, runId)
    if (!run) throw runNotFound(runId)
    if (run.status !== 'queued' && run.status !== 'waiting_human') {
      throw notCancellable(
        run.status === 'running' ? 'A running run can be cancelled from M2; wait for it to pause or end.' : 'The run has already ended.',
      )
    }
    try {
      await store.append(
        runId,
        [{ type: 'run.state_changed', payload: { from: run.status, to: 'cancelled' }, labels: [] }],
        { expect: { status: run.status } },
      )
    } catch (err) {
      if (err instanceof StateConflictError) throw notCancellable('The run changed state while cancelling. Check GET /v1/runs/{id} and retry.')
      throw err
    }
    return reply.code(202).send({ run_id: runId, status: 'cancelled' })
  })
}
