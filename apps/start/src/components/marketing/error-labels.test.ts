import { describe, expect, test } from 'vitest';
import { describeMarketingError, MarketingApiError } from './api';
import { ERROR_LABELS } from './error-labels';

const REQUIRED_CODES = [
  'invalid_transition',
  'missing_audience',
  'audience_snapshot_stale',
  'invalid_filter',
  'channel_not_configured',
  'rate_required',
  'quota_required',
  'consent_not_supported',
  'quota_not_supported',
  'template_not_found',
  'template_disabled',
  'definition_too_large',
  'template_mapping_missing',
  'template_channel_mismatch',
  'count_preview_required',
  'confirmation_mismatch',
  'quota_spread_required',
  'another_campaign_active',
  'template_unavailable',
  'invalid_send_time',
  'schedule_in_past',
  'version_conflict',
  'audience_in_use',
  'ids_limit',
  'not_snapshot',
  'snapshot_too_large',
  'freeze_in_progress',
  'source_not_configured',
  'source_not_http',
  'source_unavailable',
  'source_auth_failed',
  'source_error',
  'invalid_audience',
  'invalid_campaign',
  'not_draft',
  'mapping_mismatch',
  'channel_immutable',
  'invalid_settings',
  'channel_unavailable',
  'test_send_limit',
  'invalid_profile_id',
  'too_many_inputs',
  'source_is_http',
  'source_protocol_error',
  'too_many_requests',
  'invalid_body',
  'invalid_query',
  'invalid_json',
  'not_configured',
  'freeze_lock_lost',
  'secret_required',
  'marketing_unavailable',
  'marketing_timeout',
  'core_timeout',
  'internal',
  'invalid_project',
  'method_not_allowed',
  'network_error',
];

describe('error labels', () => {
  test('every code has a sentence that is not the code', () => {
    for (const code of REQUIRED_CODES) {
      const label = ERROR_LABELS[code];
      expect(label, code).toBeTruthy();
      expect(label, code).not.toBe(code);
    }
  });

  test('an unknown http status and a network failure read as sentences', () => {
    expect(
      describeMarketingError(new MarketingApiError(502, 'http_502', [], null))
    ).toBe('The server answered with an error (502).');
    expect(
      describeMarketingError(
        new MarketingApiError(0, 'network_error', [], null)
      )
    ).toBe('Could not reach the server');
  });

  test('version_conflict tells the user to reload', () => {
    expect(
      describeMarketingError(
        new MarketingApiError(409, 'version_conflict', [], null)
      )
    ).toBe('Someone else changed this. Reload and try again.');
  });

  test('unknown codes fall back to the code and issues are appended', () => {
    expect(
      describeMarketingError(
        new MarketingApiError(400, 'zzz_unknown', [], null)
      )
    ).toBe('zzz_unknown');
    expect(
      describeMarketingError(
        new MarketingApiError(
          400,
          'invalid_campaign',
          [{ path: 'name', message: 'required' }],
          null
        )
      )
    ).toContain('name: required');
  });

  test('existing labels still work', () => {
    expect(
      describeMarketingError(new MarketingApiError(403, 'forbidden', [], null))
    ).toBe('You do not have permission to do this');
  });

  test('an audience in use cannot be changed either', () => {
    expect(ERROR_LABELS.audience_in_use).toBe(
      'This audience is used by a campaign and cannot be changed or deleted.'
    );
  });
});
