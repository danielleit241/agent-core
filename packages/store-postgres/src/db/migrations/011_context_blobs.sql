-- Content stored once per tenant by its SHA-256: the parts of every LLM request. Never updated.
CREATE TABLE context_blobs (
  tenant_id text NOT NULL,
  hash char(64) NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, hash)
);

ALTER TABLE context_blobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_blobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON context_blobs TO agentcore_app
  USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT ON context_blobs TO agentcore_app;
