const DISPATCH_ERRORS: Record<string, string> = {
  source_unavailable: 'Waiting: the audience API is not answering',
  source_auth_failed: 'Waiting: the audience API refused our credentials',
  source_error: 'Waiting: the audience API returned an error',
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
  rate_limited: 'Provider asked us to slow down; will retry',
  channel_error: 'Channel provider error; will retry',
  failed: 'Campaign failed before sending',
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

const PROVIDER_PREFIXES = ['msg91 ', 'fcm ', 'smtp ', 'http '];
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
  const prefix = PROVIDER_PREFIXES.find((candidate) =>
    reason.startsWith(candidate)
  );
  return prefix ? `Provider answered ${reason.slice(prefix.length)}` : reason;
}
