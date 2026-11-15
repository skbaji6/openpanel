ALTER TABLE marketing.message_templates DROP CONSTRAINT IF EXISTS message_templates_channel_check;
ALTER TABLE marketing.message_templates ADD CONSTRAINT message_templates_channel_check CHECK (channel IN ('sms', 'whatsapp', 'push', 'email'));

ALTER TABLE marketing.message_template_versions ADD COLUMN IF NOT EXISTS content jsonb NULL;
ALTER TABLE marketing.message_template_versions ALTER COLUMN provider_ref DROP NOT NULL;
ALTER TABLE marketing.message_template_versions ALTER COLUMN approved_text DROP NOT NULL;
ALTER TABLE marketing.message_template_versions DROP CONSTRAINT IF EXISTS message_template_versions_content_xor_provider_ref;
ALTER TABLE marketing.message_template_versions ADD CONSTRAINT message_template_versions_content_xor_provider_ref CHECK ((content IS NULL) = (provider_ref IS NOT NULL));
