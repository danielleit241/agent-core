CREATE TABLE tenants (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9_-]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE api_keys (
  tenant_id text NOT NULL,
  id text NOT NULL,
  key_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
-- Before RLS is enabled: FORCE gives the owner no policy, so this insert would be refused afterwards.
INSERT INTO tenants (id) VALUES ('default');

-- Roles are cluster-wide; two test databases can migrate at the same moment, so a lost race is not an error.
DO $$ BEGIN CREATE ROLE agentcore_app NOLOGIN NOBYPASSRLS; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE agentcore_claim NOLOGIN NOBYPASSRLS; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$;
GRANT USAGE ON SCHEMA public TO agentcore_app, agentcore_claim;

-- Composite keys: a row cannot point at a row of another tenant.
ALTER TABLE runs ADD CONSTRAINT runs_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE webhooks ADD CONSTRAINT webhooks_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE events DROP CONSTRAINT events_run_id_fkey;
ALTER TABLE events ADD CONSTRAINT events_tenant_run_fkey FOREIGN KEY (tenant_id, run_id) REFERENCES runs (tenant_id, id);
ALTER TABLE webhook_deliveries DROP CONSTRAINT webhook_deliveries_webhook_id_fkey;
ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_tenant_webhook_fkey
  FOREIGN KEY (tenant_id, webhook_id) REFERENCES webhooks (tenant_id, id);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants TO agentcore_app
  USING (id = current_setting('app.tenant_id', true)) WITH CHECK (id = current_setting('app.tenant_id', true));

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_keys TO agentcore_app
  USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agents TO agentcore_app
  USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON connections TO agentcore_app
  USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON runs TO agentcore_app
  USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON events TO agentcore_app
  USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON queue TO agentcore_app
  USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY claim_all ON queue TO agentcore_claim USING (true) WITH CHECK (true);

ALTER TABLE webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhooks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webhooks TO agentcore_app
  USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webhook_deliveries TO agentcore_app
  USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY claim_scan ON webhook_deliveries FOR SELECT TO agentcore_claim USING (true);
CREATE POLICY claim_lease ON webhook_deliveries FOR UPDATE TO agentcore_claim USING (true) WITH CHECK (true);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idempotency_keys TO agentcore_app
  USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- Minimal grants: the verbs the service SQL uses today, per table. events is append-only.
GRANT SELECT, INSERT ON tenants, api_keys, events, webhooks TO agentcore_app;
GRANT SELECT, INSERT, UPDATE ON agents, connections, runs, webhook_deliveries, model_profiles TO agentcore_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON queue, idempotency_keys TO agentcore_app;

GRANT SELECT, UPDATE, DELETE ON queue TO agentcore_claim;
GRANT SELECT (id, tenant_id, status, next_attempt_at), UPDATE (next_attempt_at) ON webhook_deliveries TO agentcore_claim;
