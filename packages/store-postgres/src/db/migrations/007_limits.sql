-- The tenant cost per day sums llm.responded payloads before each LLM step.
CREATE INDEX events_llm_responded_by_tenant ON events (tenant_id, created_at) WHERE type = 'llm.responded';
