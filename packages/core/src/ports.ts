import type { Message, NewEvent, StoredEvent, ToolDescriptor, Usage } from './types'

export interface LLMPort {
  complete(req: {
    model: string
    messages: Message[]
    tools: ToolDescriptor[]
  }): Promise<{ message: Message; usage: Usage; stopReason: 'end' | 'tool_calls' | 'length' }>
}

export interface ToolInvoker {
  call(
    tool: ToolDescriptor,
    args: Record<string, unknown>,
    ctx: { idempotencyKey: string; dryRun: boolean },
  ): Promise<{ content: string; isError: boolean }>
}

/**
 * `append` must assign consecutive `seq`, compute `prevHash`/`hash`, and, when a
 * `run.state_changed` event is present, update `runs.status` and `runs.waiting_reason`
 * in the same transaction.
 */
export interface RunStore {
  readEvents(runId: string): Promise<StoredEvent[]>
  append(runId: string, events: NewEvent[]): Promise<StoredEvent[]>
}
