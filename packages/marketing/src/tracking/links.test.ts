import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { RenderedMessage } from '../channels/types';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { linkKey } from './keys';
import {
  applyTracking,
  extractTrackableLinks,
  MAX_TRACKED_LINKS,
  registerLinks,
  rewriteMessageLinks,
  trackedUrl,
} from './links';
import { MAX_TOKEN_LENGTH, openLinkToken } from './token';

const NOW = new Date('2026-11-15T00:00:00.000Z');
const META = { projectId: 'p1', campaignId: 'c1' };

describe('extractTrackableLinks', () => {
  it('an href with {{profile.x}} is not tracked', () => {
    const body =
      '<a href="https://x.test/{{profile.id}}">a</a><a href="https://ok.test/">b</a>';
    expect(extractTrackableLinks('email', { body })).toEqual([
      { raw: 'https://ok.test/', url: 'https://ok.test/' },
    ]);
  });

  it('a sia:// push link is not tracked', () => {
    expect(
      extractTrackableLinks('push', { body: 'b', link: 'sia://home' })
    ).toEqual([]);
    expect(
      extractTrackableLinks('push', { body: 'b', link: 'https://a.test/x' })
    ).toEqual([{ raw: 'https://a.test/x', url: 'https://a.test/x' }]);
  });

  it('sms and whatsapp templates yield no links', () => {
    for (const channel of ['sms', 'whatsapp'] as const) {
      expect(
        extractTrackableLinks(channel, {
          body: '<a href="https://a.test">x</a>',
          link: 'https://a.test',
        })
      ).toEqual([]);
    }
  });

  it('&amp; in an href is decoded in url and kept in raw', () => {
    const [link] = extractTrackableLinks('email', {
      body: '<a href="https://a.test/?x=1&amp;y=2">x</a>',
    });
    expect(link).toEqual({
      raw: 'https://a.test/?x=1&amp;y=2',
      url: 'https://a.test/?x=1&y=2',
    });
  });

  it('21 links keep the first 20', () => {
    const body = Array.from(
      { length: MAX_TRACKED_LINKS + 1 },
      (_, i) => `<a href="https://a.test/${i}">x</a>`
    ).join('');
    const links = extractTrackableLinks('email', { body });
    expect(links).toHaveLength(MAX_TRACKED_LINKS);
    expect(links[0]?.url).toBe('https://a.test/0');
    expect(links.at(-1)?.url).toBe('https://a.test/19');
  });
});

describe('registerLinks', () => {
  beforeAll(async () => {
    await migrate();
  });
  beforeEach(resetMarketingTables);

  it('registering the same url twice returns the same id', async () => {
    const links = [{ raw: 'https://a.test/1', url: 'https://a.test/1' }];
    const first = await registerLinks(sql, 'p1', links);
    const second = await registerLinks(sql, 'p1', links);
    expect(first.get('https://a.test/1')).toBeString();
    expect(second).toEqual(first);
    const [row] = await sql.$queryRawUnsafe<{ n: number }[]>(
      'SELECT count(*)::int AS n FROM marketing.tracked_links'
    );
    expect(row?.n).toBe(1);
  });
});

describe('rewriteMessageLinks', () => {
  it('rewrite replaces body href, text url and data.link and nothing else', () => {
    const message: RenderedMessage = {
      subject: 'see https://a.test/?x=1&y=2',
      title: 'https://a.test/?x=1&y=2',
      body: '<a href="https://a.test/?x=1&amp;y=2">go</a> <a href="https://other.test">o</a>',
      text: 'go: https://a.test/?x=1&y=2 and https://a.test/?x=1&y=22',
      imageUrl: 'https://a.test/?x=1&y=2',
      data: { link: 'https://a.test/?x=1&amp;y=2', other: 'keep' },
      meta: META,
    };
    const links = new Map([['https://a.test/?x=1&amp;y=2', 'id1']]);
    const out = rewriteMessageLinks(message, links, (id) => `R/${id}`);
    expect(out).toEqual({
      ...message,
      body: '<a href="R/id1">go</a> <a href="https://other.test">o</a>',
      text: 'go: R/id1 and R/id12',
      data: { link: 'R/id1', other: 'keep' },
    });
  });
});

describe('applyTracking', () => {
  it('a token over 512 characters leaves that link unchanged', () => {
    const plan = {
      campaignUrl: 'https://c.test',
      links: new Map([['https://a.test/', 'id1']]),
      key: linkKey('k', 'p1'),
    };
    const message: RenderedMessage = {
      body: '<a href="https://a.test/">x</a>',
      meta: META,
    };
    const tooLong = 'x'.repeat(MAX_TOKEN_LENGTH);
    expect(
      applyTracking(
        plan,
        { projectId: 'p1', sourceRef: tooLong, now: NOW },
        message
      )
    ).toEqual(message);
    const tracked = applyTracking(
      plan,
      { projectId: 'p1', sourceRef: 'campaign:c:u', now: NOW },
      message
    );
    const token = tracked.body.match(/\/marketing\/r\/([^"]+)"/)?.[1] ?? '';
    expect(tracked.body).toContain(trackedUrl('https://c.test', token));
    const opened = openLinkToken(() => plan.key, token, NOW);
    expect(opened.ok && opened.target.linkId).toBe('id1');
  });
});
