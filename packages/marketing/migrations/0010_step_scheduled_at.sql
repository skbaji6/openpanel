ALTER TABLE marketing.steps ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;
UPDATE marketing.steps SET scheduled_at = due_at WHERE scheduled_at IS NULL
