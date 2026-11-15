import { describe, expect, test } from 'vitest';
import {
  labelDispatchError,
  labelRecipientReason,
  labelSettingsIssue,
  labelStateReason,
  labelTestSendReason,
  labelTestSendStatus,
} from './reason-labels';

const DISPATCH_ERRORS = [
  'source_unavailable',
  'source_auth_failed',
  'source_error',
  'source_protocol_error',
  'internal_error',
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
  'completed',
  'missed',
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
    expect(labelRecipientReason('unreachable:no_live_token')).toBe(
      'No active device token'
    );
    expect(labelRecipientReason('unreachable:other')).toContain('other');
  });

  test('provider prefixes keep the provider answer', () => {
    expect(labelRecipientReason('msg91 311')).toBe('Provider answered 311');
    expect(labelRecipientReason('fcm UNREGISTERED')).toBe(
      'Provider answered UNREGISTERED'
    );
    expect(labelRecipientReason('smtp 550')).toBe('Provider answered 550');
    expect(labelRecipientReason('smtp ECONNREFUSED')).toBe(
      'The mail server could not be reached'
    );
    expect(labelRecipientReason('smtp EAI_AGAIN')).toBe(
      'The mail server could not be reached'
    );
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

  test('test-send statuses and reasons', () => {
    for (const status of ['pending', 'sending', 'sent', 'failed', 'skipped']) {
      expect(labelTestSendStatus(status), status).not.toBe(status);
    }
    for (const code of [
      'channel_not_configured',
      'template_not_found',
      'template_disabled',
      'source_not_http',
      'source_auth_failed',
      'source_unavailable',
      'uncertain',
      'cancelled',
      'failed',
    ]) {
      expect(labelTestSendReason(code), code).not.toBe(code);
    }
    expect(labelTestSendReason('rate_limited')).not.toContain('retry');
    expect(labelTestSendReason('channel_error')).not.toContain('retry');
    for (const code of ['deadline', 'breaker', 'retry']) {
      expect(labelTestSendReason(code), code).toContain('not sent');
      expect(labelTestSendReason(code), code).toContain('not be retried');
    }
    expect(labelTestSendReason('no_phone')).toBe('No phone number on file');
  });
});
