import { describe, expect, it } from 'bun:test';
import { zCampaignDraft } from './definition';

const IMAGE = 'https://cdn.example.test/a.png';

function draft(channel: string, template: Record<string, unknown>) {
  return zCampaignDraft.safeParse({ name: 'c', channel, template });
}

describe('push campaign template', () => {
  it('accepts an image and an app deep link', () => {
    const result = draft('push', {
      subject: 'Hi',
      body: 'Text',
      imageUrl: IMAGE,
      link: 'sia://course/12',
    });
    expect(result.success).toBe(true);
  });

  it('still accepts a template with neither', () => {
    expect(draft('push', { body: 'Text' }).success).toBe(true);
  });

  it.each([
    ['an http image', { imageUrl: 'http://x' }],
    ['an image with a variable', { imageUrl: 'https://x.test/{{name}}.png' }],
    ['a javascript link', { link: 'javascript:alert(1)' }],
    [
      'an image url with credentials',
      { imageUrl: 'https://user:pw@cdn.example.test/a.png' },
    ],
    ['a data link', { link: 'data:text/html,hi' }],
    ['a link that is not a URL', { link: 'not a url' }],
    ['a link with a variable', { link: 'sia://c/{{id}}' }],
    ['an over-long link', { link: `sia://c/${'a'.repeat(2000)}` }],
  ])('rejects %s', (_name, extra) => {
    expect(draft('push', { body: 'Text', ...extra }).success).toBe(false);
  });

  it('rejects an image on an email draft', () => {
    expect(draft('email', { body: 'Text', imageUrl: IMAGE }).success).toBe(
      false
    );
  });
});
