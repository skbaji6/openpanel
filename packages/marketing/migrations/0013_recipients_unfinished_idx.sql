-- Lets the completion check find a campaign's unfinished recipients without scanning its finished ones.
CREATE INDEX IF NOT EXISTS campaign_recipients_unfinished_idx ON marketing.campaign_recipients (campaign_id) WHERE status IN ('pending', 'leased', 'sending');
