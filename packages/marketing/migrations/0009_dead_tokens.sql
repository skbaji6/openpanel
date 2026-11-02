CREATE TABLE IF NOT EXISTS marketing.dead_tokens (
  project_id text NOT NULL,
  token_hash bytea NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, token_hash)
);
CREATE INDEX IF NOT EXISTS dead_tokens_seen_at_idx ON marketing.dead_tokens (seen_at);
