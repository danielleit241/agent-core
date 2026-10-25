ALTER TABLE runs ADD COLUMN idempotency_request_hash char(64);

CREATE TABLE idempotency_keys (
  tenant_id text NOT NULL,
  key text NOT NULL,
  request_hash char(64) NOT NULL,
  status_code int,
  response_body text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
