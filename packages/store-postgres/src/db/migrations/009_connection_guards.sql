-- Per-connection limits; null means the defaults.
ALTER TABLE connections ADD COLUMN limits jsonb;

-- One row per connection: the rate window and the circuit breaker. Its row lock serialises acquire and release.
CREATE TABLE connection_guards (
  tenant_id text NOT NULL,
  connection_id text NOT NULL,
  window_start timestamptz NOT NULL,
  window_calls int NOT NULL DEFAULT 0,
  failures int NOT NULL DEFAULT 0,
  opened_at timestamptz,
  trial_lease uuid,
  PRIMARY KEY (tenant_id, connection_id)
);

-- One row per call in progress. A lease that is never released expires.
CREATE TABLE connection_leases (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  connection_id text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX connection_leases_by_connection ON connection_leases (tenant_id, connection_id, expires_at);

ALTER TABLE connection_guards ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_guards FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON connection_guards TO agentcore_app
  USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE connection_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON connection_leases TO agentcore_app
  USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON connection_guards, connection_leases TO agentcore_app;
