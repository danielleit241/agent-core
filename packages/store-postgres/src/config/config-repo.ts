import type pg from 'pg'
import { resolveSafety, secretAad, toolFingerprint } from '@agent-core/core'
import { withTenant } from '../db/scope'
import type { AgentDefinition, SafetySource, SecretBox, ToolDescriptor, ToolSafety } from '@agent-core/core'

/**
 * A tool as stored: the descriptor, what the tool declared, and what an admin confirmed.
 * `reviewedFor` is the `toolFingerprint` of the definition an admin last saw: when it was registered,
 * or when its safety was confirmed.
 */
export type StoredTool = ToolDescriptor & { source: SafetySource; confirmed: Partial<ToolSafety>; reviewedFor?: string }
/**
 * A tool as read. When the definition is no longer the reviewed one, `changedSinceReview` is true,
 * `confirmed` is empty and the tool runs strict, behind approval.
 */
export type LoadedTool = StoredTool & { reviewedFor: string; fingerprint: string; changedSinceReview: boolean }
export type Connection = { id: string; kind: 'mcp' | 'webhook'; url: string; secret: string | null; tools: LoadedTool[] }
type ConnectionRow = Omit<Connection, 'tools'> & { tools: StoredTool[] }

type ConnectionDraft = Omit<ConnectionRow, 'id' | 'secret'> & { secret?: string | null }

export type Webhook = { id: string; url: string; secret: string; events: string[] }

/** Fingerprint that no definition has: a tool marked with it reads as changed until an admin confirms it. */
export const NO_REVIEW = 'none'

/**
 * The stored `safety` is only a copy: what a tool runs with is always recomputed from its source and
 * confirmations. A confirmation given for another definition is dropped. A tool stored before fingerprints
 * existed counts as reviewed when it has no confirmation, and as changed when it has one.
 */
function normalise(row: ConnectionRow): Connection {
  return {
    ...row,
    tools: row.tools.map((t): LoadedTool => {
      const source = t.source ?? {}
      const fingerprint = toolFingerprint({ ...t, source })
      const stored = t.confirmed ?? {}
      const reviewedFor = t.reviewedFor ?? (Object.keys(stored).length > 0 ? NO_REVIEW : fingerprint)
      const changedSinceReview = reviewedFor !== fingerprint
      const confirmed = changedSinceReview ? {} : stored
      return {
        ...t,
        source,
        confirmed,
        reviewedFor,
        safety: resolveSafety(source, confirmed).safety,
        fingerprint,
        changedSinceReview,
      }
    }),
  }
}

/** The stored form of a tool: the computed fields of `LoadedTool` are not written. */
const toRow = (tools: (StoredTool & Partial<LoadedTool>)[]): string =>
  JSON.stringify(
    tools.map((t) => {
      const row = { ...t }
      delete row.fingerprint
      delete row.changedSinceReview
      return row
    }),
  )

export class ConfigRepo {
  constructor(
    private readonly pool: pg.Pool,
    private readonly tenantId: string,
    private readonly secrets: SecretBox,
  ) {}

  private sealConnection(id: string, secret: string | null): string | null {
    return secret === null ? null : this.secrets.seal(secret, secretAad(this.tenantId, 'connections', id))
  }

  /** Opens the stored secret of a connection row, then normalises it. */
  private readConnection(row: ConnectionRow): Connection {
    const secret = row.secret === null ? null : this.secrets.open(row.secret, secretAad(this.tenantId, 'connections', row.id))
    return normalise({ ...row, secret })
  }

  private scoped<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return withTenant(this.pool, this.tenantId, fn)
  }

  async putConnection(c: { id: string; kind: 'mcp' | 'webhook'; url: string; secret?: string; tools: StoredTool[] }): Promise<void> {
    await this.scoped((client) =>
      client.query(
        `INSERT INTO connections (tenant_id, id, kind, url, secret, tools) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, id) DO UPDATE SET kind = EXCLUDED.kind, url = EXCLUDED.url, secret = EXCLUDED.secret, tools = EXCLUDED.tools`,
        [this.tenantId, c.id, c.kind, c.url, this.sealConnection(c.id, c.secret ?? null), toRow(c.tools)],
      ),
    )
  }

  async getConnection(id: string): Promise<Connection | null> {
    const res = await this.scoped((client) =>
      client.query('SELECT id, kind, url, secret, tools FROM connections WHERE tenant_id = $1 AND id = $2', [this.tenantId, id]),
    )
    const row = res.rows[0]
    return row ? this.readConnection(row) : null
  }

  /**
   * Builds the new connection from the stored one and writes it, as one step: concurrent calls and
   * `updateTool` see each other's writes. The advisory lock also covers a connection that does not exist yet.
   * A throw from `build` writes nothing.
   */
  async upsertConnection(
    id: string,
    build: (existing: Connection | null) => ConnectionDraft | Promise<ConnectionDraft>,
  ): Promise<Connection> {
    return this.scoped(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`connection:${this.tenantId}:${id}`])
      const res = await client.query('SELECT id, kind, url, secret, tools FROM connections WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [
        this.tenantId,
        id,
      ])
      const next = await build(res.rows[0] ? this.readConnection(res.rows[0]) : null)
      const secret = next.secret ?? null
      await client.query(
        `INSERT INTO connections (tenant_id, id, kind, url, secret, tools) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, id) DO UPDATE SET kind = EXCLUDED.kind, url = EXCLUDED.url, secret = EXCLUDED.secret, tools = EXCLUDED.tools`,
        [this.tenantId, id, next.kind, next.url, this.sealConnection(id, secret), toRow(next.tools)],
      )
      return normalise({ id, kind: next.kind, url: next.url, secret, tools: next.tools })
    })
  }

  /**
   * Changes one tool under a row lock, so two concurrent updates cannot overwrite each other.
   * Returns the updated tool as read back, or null when the connection or the tool does not exist.
   * `change` may throw to refuse the change; nothing is written then.
   */
  async updateTool(id: string, name: string, change: (t: LoadedTool) => StoredTool): Promise<LoadedTool | null> {
    return this.scoped(async (client) => {
      const res = await client.query('SELECT id, kind, url, secret, tools FROM connections WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [
        this.tenantId,
        id,
      ])
      const conn = res.rows[0] ? this.readConnection(res.rows[0]) : null
      const tool = conn?.tools.find((t) => t.name === name)
      if (!conn || !tool) return null
      const updated = change(tool)
      const tools: StoredTool[] = conn.tools.map((t) => (t === tool ? updated : t))
      await client.query('UPDATE connections SET tools = $3 WHERE tenant_id = $1 AND id = $2', [this.tenantId, id, toRow(tools)])
      return normalise({ ...conn, tools: [updated] }).tools[0]!
    })
  }

  async putAgent(def: AgentDefinition): Promise<{ id: string; version: number }> {
    const res = await this.scoped((client) =>
      client.query<{ id: string; version: number }>(
        `INSERT INTO agents (tenant_id, id, definition) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, id) DO UPDATE SET definition = EXCLUDED.definition, version = agents.version + 1
         RETURNING id, version`,
        [this.tenantId, def.id, JSON.stringify(def)],
      ),
    )
    return res.rows[0]!
  }

  async getAgent(id: string): Promise<{ definition: AgentDefinition; version: number } | null> {
    const res = await this.scoped((client) =>
      client.query('SELECT definition, version FROM agents WHERE tenant_id = $1 AND id = $2', [this.tenantId, id]),
    )
    return res.rows[0] ?? null
  }

  async putWebhook(w: Webhook): Promise<void> {
    await this.scoped((client) =>
      client.query('INSERT INTO webhooks (tenant_id, id, url, secret, events) VALUES ($1, $2, $3, $4, $5)', [
        this.tenantId,
        w.id,
        w.url,
        this.secrets.seal(w.secret, secretAad(this.tenantId, 'webhooks', w.id)),
        w.events,
      ]),
    )
  }

  async listWebhooks(): Promise<Webhook[]> {
    const res = await this.scoped((client) =>
      client.query('SELECT id, url, secret, events FROM webhooks WHERE tenant_id = $1 ORDER BY id', [this.tenantId]),
    )
    return res.rows.map((r) => ({ ...r, secret: this.secrets.open(r.secret, secretAad(this.tenantId, 'webhooks', r.id)) }))
  }
}
