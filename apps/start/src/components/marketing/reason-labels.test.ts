import { describe, expect, test } from 'vitest';
import {
  labelDispatchError,
  labelRecipientReason,
  labelSettingsIssue,
  labelStateReason,
} from './reason-labels';

const DISPATCH_ERRORS = [
  'source_unavailable',
  'source_auth_failed',
  'source_error',
  'channel_auth_failed',
  'channel_unreachable',
  'channel_not_configured',
  'quota_exhausted',
  'quiet_hours',
  'rate_limited',
  'dispatch_error',
];
const STATE_REASONS = [
  'source_error',
  'source_not_http',
  'template_not_found',
  'template_unavailable',
  'invalid_frequency_cap',
  'materialize_failed',
  'materialize_restart_after_sending',
  'late',
];
const RECIPIENT_REASONS = [
  'not_found',
  'suppressed',
  'opted_out',
  'consent',
  'capped',
  'cancelled',
  'already_received',
  'missing_variable',
  'render_failed',
  'max_attempts',
  'lease_expired',
  'operator_retry',
  'rate_limited',
  'channel_error',
  'failed',
  'no_phone',
  'no email',
  'invalid email',
  'invalid unsubscribe url',
  'no device tokens',
  'blocked url',
  'timeout',
  'network',
  'network error',
  'exception',
  'deadline',
  'breaker',
  'msg91 failed',
  'msg91 conflicting',
  'msg91 unlisted',
];

describe('reason labels', () => {
  test('every dispatch error and state reason has a label', () => {
    for (const code of DISPATCH_ERRORS) {
      expect(labelDispatchError(code), code).not.toBe(code);
    }
    for (const code of STATE_REASONS) {
      expect(labelStateReason(code), code).not.toBe(code);
    }
  });

  test('every fixed recipient reason has a label', () => {
    for (const reason of RECIPIENT_REASONS) {
      expect(labelRecipientReason(reason), reason).not.toBe(reason);
    }
  });

  test('unreachable reasons name the cause', () => {
    const label = labelRecipientReason('unreachable:no_live_token');
    expect(label).toContain('no_live_token');
    expect(label).not.toBe('unreachable:no_live_token');
  });

  test('provider prefixes keep the provider answer', () => {
    expect(labelRecipientReason('msg91 311')).toBe('Provider answered 311');
    expect(labelRecipientReason('fcm UNREGISTERED')).toBe(
      'Provider answered UNREGISTERED'
    );
    expect(labelRecipientReason('smtp 550')).toBe('Provider answered 550');
    expect(labelRecipientReason('http 502')).toBe('Provider answered 502');
  });

  test('plain codes and unknown reasons', () => {
    expect(labelRecipientReason('no_phone')).toBe('No phone number on file');
    expect(labelRecipientReason('deadline')).toContain('later');
    expect(labelRecipientReason('something odd')).toBe('something odd');
    expect(labelStateReason('brand_new')).toBe('brand_new');
    expect(labelDispatchError('brand_new')).toBe('brand_new');
  });

  test('settings issues', () => {
    for (const code of [
      'rate_required',
      'quota_required',
      'consent_not_supported',
      'quota_not_supported',
    ]) {
      expect(labelSettingsIssue(code), code).not.toBe(code);
    }
  });
});
