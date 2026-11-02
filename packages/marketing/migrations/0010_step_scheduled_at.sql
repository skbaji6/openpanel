-- Readers use COALESCE(scheduled_at, due_at), so rows from before this migration need no backfill
ALTER TABLE marketing.steps ADD COLUMN IF NOT EXISTS scheduled_at timestamptz
