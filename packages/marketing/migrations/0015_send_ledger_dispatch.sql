ALTER TABLE marketing.campaigns
  ADD COLUMN IF NOT EXISTS template_version int NULL,
  ADD COLUMN IF NOT EXISTS dispatch_retry_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS dispatch_error text NULL,
  ADD COLUMN IF NOT EXISTS dispatch_failures int NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS campaigns_dispatch_idx ON marketing.campaigns (dispatch_retry_at) WHERE state = 'running' AND materialize_state = 'done';

-- source_ref is campaign:<campaignId>:<profileId> or step:<enrollmentId>:<stepIndex>.
CREATE TABLE IF NOT EXISTS marketing.send_ledger (
  source_ref text PRIMARY KEY,
  project_id text NOT NULL,
  profile_id text NOT NULL,
  channel text NOT NULL,
  sent_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS send_ledger_person_idx ON marketing.send_ledger (project_id, profile_id, sent_at) INCLUDE (channel);
CREATE INDEX IF NOT EXISTS send_ledger_channel_day_idx ON marketing.send_ledger (project_id, channel, sent_at);
CREATE INDEX IF NOT EXISTS send_ledger_sent_at_idx ON marketing.send_ledger (sent_at);

-- Journey sends made before the ledger existed still count toward frequency caps.
INSERT INTO marketing.send_ledger (source_ref, project_id, profile_id, channel, sent_at)
SELECT 'step:' || s.enrollment_id || ':' || s.step_index, e.project_id, e.profile_id, e.rule_snapshot->'steps'->s.step_index->>'channel', s.sent_at
FROM marketing.steps s
JOIN marketing.enrollments e ON e.id = s.enrollment_id
WHERE s.status IN ('sent', 'sending') AND s.sent_at IS NOT NULL AND e.rule_snapshot->'steps'->s.step_index->>'channel' IS NOT NULL
ON CONFLICT DO NOTHING;

ALTER TABLE marketing.campaign_recipients ADD COLUMN IF NOT EXISTS lease_token uuid NULL;

CREATE INDEX IF NOT EXISTS campaign_recipients_token_idx ON marketing.campaign_recipients (lease_token) WHERE lease_token IS NOT NULL;

ALTER TABLE marketing.campaign_test_sends
  ADD COLUMN IF NOT EXISTS lease_until timestamptz NULL,
  ADD COLUMN IF NOT EXISTS provider_ref text NULL;
