-- Set when a human sends input to a run whose job a worker holds; the worker's requeue then makes the job due at once.
ALTER TABLE queue ADD COLUMN nudged_at timestamptz;
