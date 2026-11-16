import { describe, expect, it } from 'bun:test';
import { redactSecrets } from './redact';

describe('redactSecrets', () => {
  it('removes a configured secret, a Bearer token and a private_key value from an Error', () => {
    const error = new Error(
      'POST failed with whsec_abc123 and Authorization: Bearer ya29.tok-en_1 sent'
    );
    const out = redactSecrets(error, ['whsec_abc123']);
    expect(out).not.toContain('whsec_abc123');
    expect(out).not.toContain('ya29.tok-en_1');
    expect(out).toContain('[redacted]');
    expect(out).toContain('POST failed');
  });

  it('removes a private_key value from a JSON string', () => {
    const json = JSON.stringify({
      type: 'service_account',
      private_key:
        '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\n',
    });
    const out = redactSecrets(json, []);
    expect(out).not.toContain('MIIabc');
    expect(out).toContain('service_account');
  });

  it('removes a PEM block and every occurrence of each secret', () => {
    const out = redactSecrets(
      'k=-----BEGIN PRIVATE KEY-----\nXYZ\n-----END PRIVATE KEY----- s=pw pw',
      ['pw', '']
    );
    expect(out).toBe('k=[redacted] s=[redacted] [redacted]');
  });

  it('stringifies objects', () => {
    expect(redactSecrets({ message: 'token secret1' }, ['secret1'])).toBe(
      '{"message":"token [redacted]"}'
    );
  });

  it('leaves unrelated text unchanged', () => {
    expect(redactSecrets('550 mailbox unavailable', ['zzz'])).toBe(
      '550 mailbox unavailable'
    );
  });
});
