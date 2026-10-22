CREATE INDEX steps_sending_lease_idx ON nudge.steps (lease_until) WHERE status = 'sending';

CREATE INDEX devices_profile_idx ON nudge.devices (project_id, profile_id);
