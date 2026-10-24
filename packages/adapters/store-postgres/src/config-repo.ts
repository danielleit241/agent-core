import type pg from 'pg'
import type { AgentDefinition, ToolDescriptor } from '@agent-core/core'

export type Webhook = { id: string; url: string; secret: string; events: string[] }

export class ConfigRepo {
  constructor(
    private readonly pool: pg.Pool,
    private readonly tenantId: string,
  ) {}

  async putConnection(c: { id: string; url: string; tools: ToolDescriptor[] }): Promise<void> {
    await this.pool.query(
      `INSERT INTO connections (tenant_id, id, kind, url, tools) VALUES ($1, $2, 'mcp', $3, $4)
       ON CONFLICT (tenant_id, id) DO UPDATE SET url = EXCLUDED.url, tools = EXCLUDED.tools`,
      [this.tenantId, c.id, c.url, JSON.stringify(c.tools)],
    )
  }

  async getConnection(id: string): Promise<{ id: string; kind: 'mcp'; url: string; tools: ToolDescriptor[] } | null> {
    const res = await this.pool.query('SELECT id, kind, url, tools FROM connections WHERE tenant_id = $1 AND id = $2', [
      this.tenantId,
      id,
    ])
    return res.rows[0] ?? null
  }

  async putAgent(def: AgentDefinition): Promise<{ id: string; version: number }> {
    const res = await this.pool.query<{ id: string; version: number }>(
      `INSERT INTO agents (tenant_id, id, definition) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, id) DO UPDATE SET definition = EXCLUDED.definition, version = agents.version + 1
       RETURNING id, version`,
      [this.tenantId, def.id, JSON.stringify(def)],
    )
    return res.rows[0]!
  }

  async getAgent(id: string): Promise<{ definition: AgentDefinition; version: number } | null> {
    const res = await this.pool.query('SELECT definition, version FROM agents WHERE tenant_id = $1 AND id = $2', [
      this.tenantId,
      id,
    ])
    return res.rows[0] ?? null
  }

  async putWebhook(w: Webhook): Promise<void> {
    await this.pool.query('INSERT INTO webhooks (tenant_id, id, url, secret, events) VALUES ($1, $2, $3, $4, $5)', [
      this.tenantId,
      w.id,
      w.url,
      w.secret,
      w.events,
    ])
  }

  async listWebhooks(): Promise<Webhook[]> {
    const res = await this.pool.query('SELECT id, url, secret, events FROM webhooks WHERE tenant_id = $1 ORDER BY id', [
      this.tenantId,
    ])
    return res.rows
  }
}
