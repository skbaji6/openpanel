CREATE INDEX enrollments_reentry_idx
  ON nudge.enrollments (project_id, profile_id, rule_id, match_value, created_at);
