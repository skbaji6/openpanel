ALTER TABLE marketing.rules DROP CONSTRAINT IF EXISTS rules_status_check;
ALTER TABLE marketing.rules ADD CONSTRAINT rules_status_check CHECK (status IN ('draft', 'active', 'paused'));

ALTER TABLE marketing.rules
  ADD COLUMN IF NOT EXISTS journey_key text NULL,
  ADD COLUMN IF NOT EXISTS unconfirmed text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS imported_steps_hash text NULL;

CREATE UNIQUE INDEX IF NOT EXISTS rules_journey_key_uniq ON marketing.rules (project_id, journey_key) WHERE journey_key IS NOT NULL;
