CREATE TABLE marketing.audience_sources (
  project_id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('stored', 'http')),
  base_url text,
  key_id text,
  secret_encrypted text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
