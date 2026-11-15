const DISPATCH_ERRORS: Record<string, string> = {
  source_unavailable: 'Waiting: the audience API is not answering',
  source_auth_failed: 'Waiting: the audience API refused our credentials',
  source_error: 'Waiting: the audience API returned an error',
  source_protocol_error:
    'Waiting: the audience API answered in an unexpected format',
  internal_error: 'Waiting: an unexpected error happened and will be retried',
  channel_auth_failed: 'Waiting: the channel provider refused our credentials',
  channel_unreachable: 'Waiting: the channel provider cannot be reached',
  channel_not_configured: 'Waiting: the channel is not set up',
  quota_exhausted: "Waiting: today's daily quota is used up",
  quiet_hours: 'Waiting: quiet hours are on',
  rate_limited: 'Waiting: the provider asked us to slow down',
  dispatch_error: 'Waiting: sending hit an unexpected error and will retry',
};

const STATE_REASONS: Record<string, string> = {
  source_error: 'The audience API returned an error',
  source_not_http: 'The audience source is not an HTTP API',
  template_not_found: 'The message template no longer exists',
  template_unavailable: 'The message template is no longer available',
  invalid_frequency_cap: 'The limit per student is not valid',
  materialize_failed: 'The audience could not be prepared',
  materialize_restart_after_sending:
    'The audience was prepared again after sending had begun',
  late: 'The send time passed while the system was down',
};

const RECIPIENT_REASONS: Record<string, string> = {
  not_found: 'Student not found in the audience API',
  suppressed: 'Suppressed by the audience API',
  opted_out: 'Student opted out',
  consent: 'No consent to receive this channel',
  capped: 'Limit per student reached',
  cancelled: 'Campaign cancelled before sending',
  already_received: 'Already received a campaign with this key',
  missing_variable: 'A variable had no value for this student',
  render_failed: 'The message could not be built for this student',
  max_attempts: 'Gave up after too many attempts',
  lease_expired: 'Sending was interrupted and could not be confirmed',
  operator_retry: 'Retried by an operator',
  unknown: 'No reason was recorded',
  rate_limited: 'Provider asked us to slow down; will retry',
  channel_error: 'Channel provider error; will retry',
  failed: 'Campaign failed before sending',
  completed: 'Campaign had already finished',
  missed: 'Campaign missed its send time',
  no_state_trait: 'The student has no state in the audience API',
  no_variant_for_state:
    "No message for the student's state and no default message",
  template_not_pinned: 'The template was not pinned; restart the journey',
  'unreachable:no_live_token': 'No active device token',
  no_phone: 'No phone number on file',
  'no email': 'No email address on file',
  'invalid email': 'Email address is not valid',
  'invalid unsubscribe url': 'Unsubscribe link could not be built',
  'no device tokens': 'No registered devices',
  'blocked url': 'The address is not allowed',
  timeout: 'The provider took too long to answer',
  network: 'Network problem while sending',
  'network error': 'Network problem while sending',
  exception: 'Unexpected error while sending',
  deadline: 'Not sent in this batch; will be tried later',
  breaker: 'Held back while the provider is failing; will be tried later',
  'msg91 failed': 'MSG91 reported the message as failed',
  'msg91 conflicting': 'MSG91 gave conflicting answers; delivery is unknown',
  'msg91 unlisted': 'MSG91 did not list this message; delivery is unknown',
};

const SETTINGS_ISSUES: Record<string, string> = {
  rate_required: 'Set a messages-per-second limit',
  quota_required: 'Set a daily quota',
  consent_not_supported: 'Consent filtering is not available for this channel',
  quota_not_supported: 'A daily quota is only available for email',
};

const TEST_SEND_STATUSES: Record<string, string> = {
  pending: 'Waiting to send',
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Failed',
  skipped: 'Skipped',
};

// A test send is tried once, so reasons that promise a retry are reworded.
const TEST_SEND_REASONS: Record<string, string> = {
  cancelled: 'The campaign was cancelled',
  failed: 'The campaign failed',
  channel_not_configured: 'The channel is not set up',
  template_not_found: 'The message template no longer exists',
  template_disabled: 'The message template is turned off',
  source_not_http: 'The audience source is not an HTTP API',
  source_auth_failed: 'The audience API refused our credentials',
  source_unavailable: 'The audience API is not answering',
  uncertain: 'Sending was interrupted; it may or may not have arrived',
  rate_limited: 'The channel was busy; not sent',
  channel_error: 'Channel provider error; not sent',
  deadline: 'Did not go out in time; not sent and will not be retried',
  breaker:
    'Held back while the provider is failing; not sent and will not be retried',
  retry: 'The provider asked to try later; not sent and will not be retried',
};

const PROVIDER_PREFIXES = ['msg91 ', 'fcm ', 'smtp ', 'http '];
const MAIL_NETWORK_ERROR = /^smtp E[A-Z_]+$/;
const UNREACHABLE_PREFIX = 'unreachable:';

export const labelDispatchError = (code: string): string =>
  DISPATCH_ERRORS[code] ?? code;

export const labelStateReason = (code: string): string =>
  STATE_REASONS[code] ?? code;

export const labelSettingsIssue = (code: string): string =>
  SETTINGS_ISSUES[code] ?? code;

export function labelRecipientReason(reason: string): string {
  const known = RECIPIENT_REASONS[reason];
  if (known) {
    return known;
  }
  if (reason.startsWith(UNREACHABLE_PREFIX)) {
    return `Could not be reached: ${reason.slice(UNREACHABLE_PREFIX.length)}`;
  }
  if (MAIL_NETWORK_ERROR.test(reason)) {
    return 'The mail server could not be reached';
  }
  const prefix = PROVIDER_PREFIXES.find((candidate) =>
    reason.startsWith(candidate)
  );
  return prefix ? `Provider answered ${reason.slice(prefix.length)}` : reason;
}

export const labelTestSendStatus = (status: string): string =>
  TEST_SEND_STATUSES[status] ?? status;

export const labelTestSendReason = (reason: string): string =>
  TEST_SEND_REASONS[reason] ?? labelRecipientReason(reason);

const RECIPIENT_STATUS_LABELS: Record<string, string> = {
  pending: 'Waiting',
  leased: 'Picked up',
  sending: 'Sending',
  sent: 'Sent',
  uncertain: 'Uncertain',
  failed: 'Failed',
  skipped: 'Skipped',
};

export const labelRecipientStatus = (status: string): string =>
  RECIPIENT_STATUS_LABELS[status] ?? status;
