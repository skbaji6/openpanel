import { describe, expect, it } from 'bun:test';
import { createUnsubscribeUrlRenderer } from './unsubscribe';

const render = createUnsubscribeUrlRenderer({
  encryptionKey: 'k'.repeat(32),
  publicUrl: 'https://marketing.example.test',
});

describe('createUnsubscribeUrlRenderer', () => {
  it.each([
    'email',
    'push',
    'webhook',
    'sms',
    'whatsapp',
  ])('renders a link for the %s channel', (channel) => {
    expect(render('p1', 'u1', channel)).toStartWith(
      'https://marketing.example.test/marketing/unsubscribe?t='
    );
  });

  it('still refuses an unknown channel', () => {
    expect(() => render('p1', 'u1', 'carrier-pigeon')).toThrow();
  });
});
