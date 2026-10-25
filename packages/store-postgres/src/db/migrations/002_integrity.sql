ALTER TABLE runs ADD COLUMN last_seq int, ADD COLUMN last_hash char(64);
UPDATE runs r SET last_seq = e.seq, last_hash = e.hash
  FROM (SELECT DISTINCT ON (run_id) run_id, seq, hash FROM events ORDER BY run_id, seq DESC) e
 WHERE e.run_id = r.id;

CREATE FUNCTION events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'events is append-only (% blocked)', TG_OP;
END;
$$;
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_append_only();

CREATE UNIQUE INDEX webhook_deliveries_webhook_event ON webhook_deliveries (webhook_id, event_id);
