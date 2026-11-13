CREATE TABLE IF NOT EXISTS marketing.channel_settings (
  project_id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('push', 'whatsapp', 'sms', 'email', 'webhook')),
  settings jsonb NOT NULL,
  version int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, channel)
);

CREATE TABLE IF NOT EXISTS marketing.message_templates (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('sms', 'whatsapp')),
  enabled boolean NOT NULL DEFAULT true,
  current_version int NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS message_templates_project_channel_idx ON marketing.message_templates (project_id, channel);

-- Rows are immutable: a change is a new version.
CREATE TABLE IF NOT EXISTS marketing.message_template_versions (
  template_id uuid NOT NULL REFERENCES marketing.message_templates (id) ON DELETE CASCADE,
  version int NOT NULL,
  display_name text NOT NULL,
  category text NOT NULL CHECK (category IN ('promotional', 'service')),
  provider_ref jsonb NOT NULL,
  approved_text text NOT NULL,
  variables jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, version)
);
