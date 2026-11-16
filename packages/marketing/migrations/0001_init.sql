CREATE TABLE marketing.rules (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'paused')),
  definition jsonb NOT NULL,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE marketing.enrollments (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  rule_id uuid NOT NULL,
  rule_snapshot jsonb NOT NULL,
  profile_id text NOT NULL,
  match_value text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
  trigger_time timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX enrollments_active_uniq
  ON marketing.enrollments (project_id, rule_id, profile_id, match_value)
  WHERE status = 'active';

CREATE TABLE marketing.steps (
  enrollment_id uuid NOT NULL,
  step_index int NOT NULL,
  due_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'failed', 'cancelled')),
  lease_until timestamptz,
  attempt int NOT NULL DEFAULT 0,
  outcome jsonb,
  sent_at timestamptz,
  PRIMARY KEY (enrollment_id, step_index)
);

CREATE INDEX steps_pending_due_idx ON marketing.steps (due_at) WHERE status = 'pending';

CREATE TABLE marketing.events (
  project_id text NOT NULL,
  event_id text NOT NULL,
  profile_id text NOT NULL,
  name text NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}',
  event_time timestamptz NOT NULL,
  PRIMARY KEY (project_id, event_id)
);

CREATE INDEX events_lookup_idx ON marketing.events (project_id, profile_id, name, event_time);

CREATE TABLE marketing.reference_sets (
  project_id text NOT NULL,
  set_key text NOT NULL,
  values jsonb NOT NULL,
  PRIMARY KEY (project_id, set_key)
);

CREATE TABLE marketing.contacts (
  project_id text NOT NULL,
  profile_id text NOT NULL,
  email text,
  attributes jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, profile_id)
);

CREATE TABLE marketing.devices (
  token text PRIMARY KEY,
  project_id text NOT NULL,
  profile_id text NOT NULL,
  platform text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE marketing.opt_outs (
  project_id text NOT NULL,
  profile_id text NOT NULL,
  channel text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, profile_id, channel)
);

CREATE TABLE marketing.channel_configs (
  project_id text NOT NULL,
  channel text NOT NULL,
  config_encrypted text NOT NULL,
  PRIMARY KEY (project_id, channel)
);

CREATE TABLE marketing.api_keys (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  key_hash text NOT NULL,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE marketing.project_settings (
  project_id text PRIMARY KEY,
  caps jsonb,
  quiet_hours jsonb
);

CREATE TABLE marketing.consumer_state (
  id int PRIMARY KEY CHECK (id = 1),
  lag bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
