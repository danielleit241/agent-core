CREATE TABLE model_profiles (
  model text PRIMARY KEY,
  profile jsonb,
  proposed jsonb,
  probes jsonb,
  checked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
