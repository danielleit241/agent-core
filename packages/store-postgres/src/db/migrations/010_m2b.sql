-- /readyz reads the list of applied migrations.
GRANT SELECT ON schema_migrations TO agentcore_app;

-- /metrics counts runs per status across tenants as agentcore_claim: the status column only, no tenant data.
GRANT SELECT (status) ON runs TO agentcore_claim;
CREATE POLICY claim_count ON runs FOR SELECT TO agentcore_claim USING (true);
