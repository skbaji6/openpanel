CREATE INDEX enrollments_reentry_idx
  ON marketing.enrollments (project_id, profile_id, rule_id, match_value, created_at);
