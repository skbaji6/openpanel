CREATE TABLE IF NOT EXISTS marketing.message_tracking (
  source_ref text PRIMARY KEY,
  project_id text NOT NULL,
  profile_id text NOT NULL,
  channel text NULL,
  campaign_id uuid NULL,
  rule_id uuid NULL,
  step_index int NULL,
  status text NOT NULL CHECK (status IN ('skipped', 'uncertain', 'sent', 'failed', 'delivered', 'read', 'clicked', 'converted')),
  reason text NULL,
  provider_ref text NULL,
  sent_at timestamptz NOT NULL,
  accepted_at timestamptz NULL,
  delivered_at timestamptz NULL,
  read_at timestamptz NULL,
  clicked_at timestamptz NULL,
  converted_at timestamptz NULL,
  failed_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS message_tracking_provider_ref_idx ON marketing.message_tracking (provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS message_tracking_person_idx ON marketing.message_tracking (project_id, profile_id, sent_at DESC) WHERE accepted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS message_tracking_campaign_idx ON marketing.message_tracking (campaign_id, sent_at) WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS message_tracking_rule_idx ON marketing.message_tracking (rule_id, sent_at) WHERE rule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS message_tracking_sent_at_idx ON marketing.message_tracking (sent_at);

CREATE TABLE IF NOT EXISTS marketing.tracked_links (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  url text NOT NULL CHECK (length(url) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tracked_links_project_url_idx ON marketing.tracked_links (project_id, md5(url));

CREATE TABLE IF NOT EXISTS marketing.journey_variant_counts (
  project_id text NOT NULL,
  rule_id uuid NOT NULL,
  step_index int NOT NULL,
  variant_key text NOT NULL,
  day date NOT NULL,
  sent int NOT NULL DEFAULT 0,
  skipped int NOT NULL DEFAULT 0,
  failed int NOT NULL DEFAULT 0,
  PRIMARY KEY (rule_id, step_index, variant_key, day)
);

ALTER TABLE marketing.project_settings ADD COLUMN IF NOT EXISTS tracking jsonb NULL;

-- The furthest status wins: skipped < uncertain < sent < failed < delivered < read < clicked < converted.
CREATE OR REPLACE FUNCTION marketing.message_status_rank(status text) RETURNS int
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE status
    WHEN 'skipped' THEN 0
    WHEN 'uncertain' THEN 1
    WHEN 'sent' THEN 2
    WHEN 'failed' THEN 3
    WHEN 'delivered' THEN 4
    WHEN 'read' THEN 5
    WHEN 'clicked' THEN 6
    WHEN 'converted' THEN 7
    ELSE -1
  END
$$;

CREATE OR REPLACE FUNCTION marketing.upsert_message_tracking(
  p_source_ref text, p_project_id text, p_profile_id text, p_channel text,
  p_campaign_id uuid, p_rule_id uuid, p_step_index int,
  p_status text, p_reason text, p_provider_ref text, p_sent_at timestamptz
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO marketing.message_tracking AS t (
    source_ref, project_id, profile_id, channel, campaign_id, rule_id, step_index,
    status, reason, provider_ref, sent_at, accepted_at, failed_at
  ) VALUES (
    p_source_ref, p_project_id, p_profile_id, p_channel, p_campaign_id, p_rule_id, p_step_index,
    p_status, p_reason, p_provider_ref, p_sent_at,
    CASE WHEN p_status = 'sent' THEN p_sent_at END,
    CASE WHEN p_status = 'failed' THEN p_sent_at END
  )
  ON CONFLICT (source_ref) DO UPDATE SET
    status = CASE WHEN marketing.message_status_rank(EXCLUDED.status) > marketing.message_status_rank(t.status)
      THEN EXCLUDED.status ELSE t.status END,
    reason = CASE WHEN marketing.message_status_rank(EXCLUDED.status) > marketing.message_status_rank(t.status)
      THEN EXCLUDED.reason ELSE t.reason END,
    provider_ref = COALESCE(EXCLUDED.provider_ref, t.provider_ref),
    channel = COALESCE(t.channel, EXCLUDED.channel),
    sent_at = EXCLUDED.sent_at,
    accepted_at = COALESCE(t.accepted_at, EXCLUDED.accepted_at),
    failed_at = CASE WHEN marketing.message_status_rank(t.status) < marketing.message_status_rank('failed')
      THEN COALESCE(t.failed_at, EXCLUDED.failed_at) ELSE t.failed_at END;
END
$$;

CREATE OR REPLACE FUNCTION marketing.track_campaign_recipient() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM marketing.upsert_message_tracking(
    'campaign:' || NEW.campaign_id::text || ':' || NEW.profile_id,
    NEW.project_id, NEW.profile_id,
    (SELECT c.channel FROM marketing.campaigns c WHERE c.id = NEW.campaign_id),
    NEW.campaign_id, NULL, NULL,
    NEW.status, NEW.reason, NEW.provider_ref,
    COALESCE(NEW.sent_at, NEW.updated_at)
  );
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION marketing.track_journey_step() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  enrollment record;
BEGIN
  SELECT e.project_id, e.profile_id, e.rule_id,
    e.rule_snapshot->'steps'->NEW.step_index->>'channel' AS channel
  INTO enrollment FROM marketing.enrollments e WHERE e.id = NEW.enrollment_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  PERFORM marketing.upsert_message_tracking(
    'step:' || NEW.enrollment_id::text || ':' || NEW.step_index,
    enrollment.project_id, enrollment.profile_id, enrollment.channel,
    NULL, enrollment.rule_id, NEW.step_index,
    NEW.status, NEW.outcome->>'reason', NULL,
    COALESCE(NEW.sent_at, now())
  );
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS track_campaign_recipient ON marketing.campaign_recipients;

CREATE TRIGGER track_campaign_recipient
AFTER INSERT OR UPDATE OF status ON marketing.campaign_recipients
FOR EACH ROW WHEN (NEW.status IN ('sent', 'uncertain', 'failed', 'skipped'))
EXECUTE FUNCTION marketing.track_campaign_recipient();

DROP TRIGGER IF EXISTS track_journey_step ON marketing.steps;

CREATE TRIGGER track_journey_step
AFTER INSERT OR UPDATE OF status ON marketing.steps
FOR EACH ROW WHEN (NEW.status IN ('sent', 'failed', 'skipped'))
EXECUTE FUNCTION marketing.track_journey_step();

-- Sends of the last 400 days (the retention window) made before the triggers existed, mapped as the triggers map them.
INSERT INTO marketing.message_tracking (
  source_ref, project_id, profile_id, channel, campaign_id, status, reason, provider_ref, sent_at, accepted_at, failed_at
)
SELECT 'campaign:' || r.campaign_id::text || ':' || r.profile_id, r.project_id, r.profile_id, c.channel, r.campaign_id,
  r.status, r.reason, r.provider_ref, COALESCE(r.sent_at, r.updated_at),
  CASE WHEN r.status = 'sent' THEN COALESCE(r.sent_at, r.updated_at) END,
  CASE WHEN r.status = 'failed' THEN COALESCE(r.sent_at, r.updated_at) END
FROM marketing.campaign_recipients r
JOIN marketing.campaigns c ON c.id = r.campaign_id
WHERE r.status IN ('sent', 'uncertain', 'failed', 'skipped')
  AND COALESCE(r.sent_at, r.updated_at) > now() - interval '400 days'
ON CONFLICT DO NOTHING;

INSERT INTO marketing.message_tracking (
  source_ref, project_id, profile_id, channel, rule_id, step_index, status, reason, sent_at, accepted_at, failed_at
)
SELECT 'step:' || s.enrollment_id::text || ':' || s.step_index, e.project_id, e.profile_id,
  e.rule_snapshot->'steps'->s.step_index->>'channel', e.rule_id, s.step_index,
  s.status, s.outcome->>'reason', COALESCE(s.sent_at, s.due_at),
  CASE WHEN s.status = 'sent' THEN COALESCE(s.sent_at, s.due_at) END,
  CASE WHEN s.status = 'failed' THEN COALESCE(s.sent_at, s.due_at) END
FROM marketing.steps s
JOIN marketing.enrollments e ON e.id = s.enrollment_id
WHERE s.status IN ('sent', 'failed', 'skipped')
  AND COALESCE(s.sent_at, s.due_at) > now() - interval '400 days'
ON CONFLICT DO NOTHING;
