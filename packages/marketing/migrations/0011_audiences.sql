CREATE TABLE IF NOT EXISTS marketing.audiences (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  name text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('dynamic', 'snapshot')),
  filter jsonb NULL,
  exclude_filter jsonb NULL,
  version int NOT NULL DEFAULT 1,
  snapshot_version int NULL,
  snapshot_count int NULL,
  snapshot_at timestamptz NULL,
  schema_checked_at timestamptz NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audiences_project_updated_idx ON marketing.audiences (project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS marketing.audience_ids (
  audience_id uuid NOT NULL REFERENCES marketing.audiences (id) ON DELETE CASCADE,
  list text NOT NULL CHECK (list IN ('include', 'exclude')),
  profile_id text NOT NULL,
  PRIMARY KEY (audience_id, list, profile_id)
);

CREATE TABLE IF NOT EXISTS marketing.audience_snapshot_ids (
  audience_id uuid NOT NULL REFERENCES marketing.audiences (id) ON DELETE CASCADE,
  snapshot_version int NOT NULL,
  profile_id text NOT NULL,
  PRIMARY KEY (audience_id, snapshot_version, profile_id)
);
