import { describe, expect, test } from 'vitest';
import { MarketingApiError } from './api';
import {
  canKeepSavedSecret,
  saveErrorMessage,
  secretHint,
} from './audience-source-card';

const saved = {
  baseUrl: 'https://owner.test/api',
  keyId: 'k1',
  hasSecret: true,
};

describe('audience source secret', () => {
  test('a saved secret can be kept only while the base URL and key id are unchanged', () => {
    expect(canKeepSavedSecret(saved, 'https://owner.test/api', 'k1')).toBe(
      true
    );
    expect(canKeepSavedSecret(saved, 'https://elsewhere.test', 'k1')).toBe(
      false
    );
    expect(canKeepSavedSecret(saved, 'https://owner.test/api', 'k2')).toBe(
      false
    );
    expect(
      canKeepSavedSecret({ ...saved, hasSecret: false }, saved.baseUrl, 'k1')
    ).toBe(false);
  });

  test('the hint asks for the secret again after a change', () => {
    expect(secretHint(true, true)).toContain('Leave empty');
    expect(secretHint(true, false)).toContain('enter the secret');
    expect(secretHint(false, false)).toBeUndefined();
  });

  test('secret_required has a plain message', () => {
    expect(
      saveErrorMessage(new MarketingApiError(400, 'secret_required', []))
    ).toContain('Enter the secret again');
  });
});
