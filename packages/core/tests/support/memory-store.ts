import { GENESIS_HASH, hashEvent } from '../../src/events/hash'
import { AppendConflictError, type RunStore } from '../../src/ports'
import type { NewEvent, StoredEvent } from '../../src/types'

/** An in-memory event log with the store's `expect.lastSeq` check. */
export class MemoryRunStore implements RunStore {
  private logs = new Map<string, StoredEvent[]>()
  /** Stamps `createdAt`. Tests that measure run time share it with the runner's `now`. */
  constructor(private readonly clock: () => Date = () => new Date()) {}
  async readEvents(runId: string): Promise<StoredEvent[]> {
    return [...(this.logs.get(runId) ?? [])]
  }
  async readEventsAfter(runId: string, afterSeq: number): Promise<StoredEvent[]> {
    return (this.logs.get(runId) ?? []).filter((e) => e.seq > afterSeq)
  }
  async append(runId: string, events: NewEvent[], opts?: { expect?: { lastSeq: number } }): Promise<StoredEvent[]> {
    const log = this.logs.get(runId) ?? []
    if (opts?.expect !== undefined && (log.at(-1)?.seq ?? 0) !== opts.expect.lastSeq) throw new AppendConflictError(`run ${runId} moved on`)
    const stored: StoredEvent[] = []
    for (const e of events) {
      const prev = log.at(-1)
      const partial = {
        ...e,
        tenantId: 'default',
        runId,
        seq: (prev?.seq ?? 0) + 1,
        agentVersion: 1,
        createdAt: this.clock().toISOString(),
        prevHash: prev?.hash ?? GENESIS_HASH,
      } as Omit<StoredEvent, 'hash'>
      const event = { ...partial, hash: hashEvent(partial) } as StoredEvent
      log.push(event)
      stored.push(event)
    }
    this.logs.set(runId, log)
    return stored
  }
}
