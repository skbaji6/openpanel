export const ERROR_LABELS: Record<string, string> = {
  forbidden: 'You do not have permission to do this',
  not_found: 'Not found',
  secrets_required: 'Re-enter the secrets for this channel',
  rule_reactivated: 'The rule was reactivated while deleting; try again',
  payload_too_large: 'The request is too large',
  version_conflict: 'Someone else changed this. Reload and try again.',
  invalid_transition: 'The campaign cannot do that in its current state.',
  missing_audience: 'Choose an audience for this campaign first.',
  audience_snapshot_stale:
    'The audience changed after it was frozen. Freeze it again first.',
  invalid_filter: 'The audience filter is not valid any more. Edit it first.',
  channel_not_configured:
    'Set up this channel on the Channels tab before sending.',
  rate_required:
    'Set a messages-per-second limit for this channel on the Channels tab.',
  quota_required: 'Set a daily quota for this channel on the Channels tab.',
  consent_not_supported:
    'Consent filtering is not available for this channel. Turn it off in the channel settings.',
  quota_not_supported:
    'A daily quota is only available for email. Clear it in the channel settings.',
  template_not_found: 'The message template no longer exists.',
  template_disabled: 'The message template is disabled. Enable it first.',
  template_mapping_missing:
    'The message template has no variable mapping. Edit the template.',
  template_channel_mismatch: 'The message template belongs to another channel.',
  count_preview_required:
    'Count the audience first. The count is valid for 15 minutes.',
  confirmation_required: 'Confirm the audience size and channel to continue.',
  confirmation_mismatch:
    'The audience size changed since you counted it. Count again and confirm.',
  quota_spread_required:
    'The daily quota is too small for this audience today. Spread the send over several days or lower the audience size.',
  another_campaign_active:
    'Another campaign is already running or paused in this project.',
  template_unavailable:
    'The message template is no longer available for sending.',
  invalid_send_time: 'The send time is not valid.',
  schedule_in_past: 'The send time is in the past.',
  audience_in_use: 'This audience is used by a campaign and cannot be deleted.',
  ids_limit: 'The list is too long. A list holds at most 20,000 students.',
  not_snapshot: 'Only snapshot audiences can be frozen.',
  snapshot_too_large: 'The audience is too large to freeze.',
  freeze_in_progress: 'This audience is being frozen. Try again in a moment.',
  source_not_configured:
    'The audience API is not connected. Connect it on the Channels tab.',
  source_not_http:
    'The audience source is not an HTTP API. Connect the audience API on the Channels tab.',
  source_unavailable: 'The audience API did not answer. Try again in a moment.',
  source_auth_failed:
    'The audience API refused our credentials. Check them on the Channels tab.',
  source_error: 'The audience API returned an error.',
  invalid_audience: 'The audience is not valid.',
  invalid_campaign: 'The campaign is not valid.',
  not_draft: 'Only a draft campaign can be edited. Reload to see its state.',
  mapping_mismatch:
    'The variables do not match the numbered placeholders in the approved text.',
  channel_immutable: 'A template cannot change its channel.',
  invalid_settings: 'These settings are not allowed for this channel.',
  channel_unavailable: 'This channel is not available.',
  test_send_limit: 'Test send limit reached. Try again in an hour.',
  invalid_profile_id: 'That student id is not valid.',
};
