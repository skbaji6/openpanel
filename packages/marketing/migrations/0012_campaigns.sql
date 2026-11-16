CREATE TABLE IF NOT EXISTS marketing.campaigns (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  name text NOT NULL,
  state text NOT NULL CHECK (state IN ('draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled', 'failed', 'missed')),
  state_reason text NULL,
  channel text NOT NULL CHECK (channel IN ('push', 'whatsapp', 'sms', 'email', 'webhook')),
  template jsonb NOT NULL,
  audience_id uuid NULL REFERENCES marketing.audiences (id) ON DELETE RESTRICT,
  audience_version int NULL,
  campaign_key text NULL,
  skip_previous_recipients boolean NOT NULL DEFAULT false,
  send_kind text NULL CHECK (send_kind IN ('now', 'scheduled')),
  send_at timestamptz NULL,
  send_at_local text NULL,
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  if_late_minutes int NOT NULL DEFAULT 60 CHECK (if_late_minutes BETWEEN 0 AND 1440),
  quiet_hours_override jsonb NULL,
  frequency_cap jsonb NULL,
  confirm_threshold int NOT NULL,
  count_preview jsonb NULL,
  materialize_state text NOT NULL DEFAULT 'not_started' CHECK (materialize_state IN ('not_started', 'in_progress', 'done', 'failed')),
  materialize_phase text NULL,
  materialize_cursor text NULL,
  materialize_lease_token uuid NULL,
  materialize_lease_until timestamptz NULL,
  materialize_retry_at timestamptz NULL,
  materialize_error text NULL,
  materialize_attempts int NOT NULL DEFAULT 0,
  version int NOT NULL DEFAULT 1,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NULL,
  finished_at timestamptz NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS campaigns_one_active_per_project ON marketing.campaigns (project_id) WHERE state IN ('running', 'paused');
CREATE INDEX IF NOT EXISTS campaigns_due_idx ON marketing.campaigns (send_at) WHERE state = 'scheduled';
CREATE INDEX IF NOT EXISTS campaigns_materialize_idx ON marketing.campaigns (materialize_retry_at) WHERE materialize_state IN ('not_started', 'in_progress') AND state IN ('running', 'paused');
CREATE INDEX IF NOT EXISTS campaigns_project_created_idx ON marketing.campaigns (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS campaigns_project_key_idx ON marketing.campaigns (project_id, campaign_key) WHERE campaign_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS marketing.campaign_recipients (
  campaign_id uuid NOT NULL REFERENCES marketing.campaigns (id) ON DELETE CASCADE,
  profile_id text NOT NULL,
  project_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'sending', 'sent', 'uncertain', 'failed', 'skipped')),
  reason text NULL,
  attempt int NOT NULL DEFAULT 0,
  due_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz NULL,
  idempotency_key text GENERATED ALWAYS AS (campaign_id::text || ':' || profile_id) STORED,
  provider_ref text NULL,
  sent_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, profile_id)
);

CREATE INDEX IF NOT EXISTS campaign_recipients_claim_idx ON marketing.campaign_recipients (campaign_id, due_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS campaign_recipients_lease_idx ON marketing.campaign_recipients (lease_until) WHERE status IN ('leased', 'sending');

CREATE TABLE IF NOT EXISTS marketing.materialize_exclusions (
  job_id uuid NOT NULL,
  profile_id text NOT NULL,
  PRIMARY KEY (job_id, profile_id)
);

CREATE TABLE IF NOT EXISTS marketing.campaign_counters (
  campaign_id uuid PRIMARY KEY REFERENCES marketing.campaigns (id) ON DELETE CASCADE,
  queued int NOT NULL DEFAULT 0,
  sent int NOT NULL DEFAULT 0,
  failed int NOT NULL DEFAULT 0,
  skipped int NOT NULL DEFAULT 0,
  uncertain int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketing.campaign_test_sends (
  id uuid PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES marketing.campaigns (id) ON DELETE CASCADE,
  project_id text NOT NULL,
  profile_id text NOT NULL,
  requested_by text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS campaign_test_sends_pending_idx ON marketing.campaign_test_sends (status, created_at) WHERE status = 'pending';
