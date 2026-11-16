CREATE TABLE IF NOT EXISTS marketing.journey_test_sends (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  rule_id uuid NOT NULL REFERENCES marketing.rules (id) ON DELETE CASCADE,
  step_index int NOT NULL,
  variant_key text NOT NULL,
  profile_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  reason text NULL,
  lease_until timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS journey_test_sends_status_idx ON marketing.journey_test_sends (status, created_at);
CREATE INDEX IF NOT EXISTS journey_test_sends_rule_idx ON marketing.journey_test_sends (rule_id, created_at DESC);
