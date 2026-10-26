import type { z } from 'zod'
import type { Message, NewEvent, RunStatus, StoredEvent, ToolDescriptor, Usage } from './types'

export interface LLMPort {
  complete(req: {
    model: string
    messages: Message[]
    tools: ToolDescriptor[]
    /** When set, `message.content` is JSON text that matches `schema`. */
    output?: { name: string; schema: z.ZodType }
  }): Promise<{ message: Message; usage: Usage; stopReason: 'end' | 'tool_calls' | 'length' | 'filtered' }>
}

export interface ToolInvoker {
  call(
    tool: ToolDescriptor,
    args: Record<string, unknown>,
    ctx: { idempotencyKey: string; dryRun: boolean; principal?: { id: string; roles: string[] } },
  ): Promise<{ content: string; isError: boolean }>
}

/** Thrown by `RunStore.append` when the run is not in the state the caller expected. Nothing was written. */
export class AppendConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppendConflictError'
  }
}

/**
 * `append` must assign consecutive `seq`, compute `prevHash`/`hash`, and, when a
 * `run.state_changed` event is present, update `runs.status` and `runs.waiting_reason`
 * in the same transaction. With `expect.lastSeq` it writes only when the log still ends
 * at that seq, and throws `AppendConflictError` otherwise.
 */
export interface RunStore {
  readEvents(runId: string): Promise<StoredEvent[]>
  append(runId: string, events: NewEvent[], opts?: { expect?: { lastSeq: number } }): Promise<StoredEvent[]>
}

/** Why a call to a connection must wait. `retryAt` (ISO 8601) is null for `concurrency`: the caller backs off. */
export type GuardDenial = { reason: 'rate' | 'concurrency' | 'breaker'; retryAt: string | null }

/**
 * Rate limit, concurrency limit and circuit breaker of each connection, shared by all runs and workers.
 * Every granted lease is released exactly once; `failed` means the invoker threw (a tool result with
 * `isError` is `ok`), and `unused` that the call was never sent, so the breaker learns nothing from it.
 * A lease that is never released expires, so a dead worker does not hold a slot.
 */
export interface ConnectionGuard {
  acquire(connectionId: string): Promise<{ lease: string } | { denied: GuardDenial }>
  release(lease: string, outcome: 'ok' | 'failed' | 'unused'): Promise<void>
}

/**
 * Child runs of workflow `subrun` steps, in the same tenant. `start` is idempotent per parent step: called
 * again, it returns the child it started before. `status` gives the child's status and final text.
 */
export interface SubrunPort {
  start(r: { agentId: string; input: string; parent: { runId: string; stepId: string } }): Promise<string>
  status(runId: string): Promise<{ status: RunStatus; text: string | null } | null>
}
