CREATE INDEX steps_sending_lease_idx ON marketing.steps (lease_until) WHERE status = 'sending';

CREATE INDEX devices_profile_idx ON marketing.devices (project_id, profile_id);
