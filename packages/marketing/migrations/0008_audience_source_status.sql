ALTER TABLE marketing.audience_sources ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'unknown';
ALTER TABLE marketing.audience_sources ADD COLUMN IF NOT EXISTS status_at timestamptz;
