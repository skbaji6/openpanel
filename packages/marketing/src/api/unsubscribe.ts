import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { MarketingConfig } from '../config';
import type { Queryable } from '../engine/engine';
import { HttpError } from './http';
import type { RateLimiter } from './rate-limit';

const HKDF_INFO = 'marketing-unsubscribe';
const KEY_BYTES = 32;
// Bounds the work done on an unauthenticated input; covers profile ids up to about 2,900 characters.
const MAX_TOKEN_LENGTH = 4096;
const CHANNELS = ['email', 'push', 'webhook'] as const;
const CHANNEL_LABELS: Record<(typeof CHANNELS)[number], string> = {
  email: 'email',
  push: 'push notification',
  webhook: 'webhook',
};
const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  // The token is in the URL; it must not leak to other sites.
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

export interface UnsubscribeTarget {
  projectId: string;
  profileId: string;
  channel: (typeof CHANNELS)[number];
}

const zToken = z.tuple([
  z.string().min(1),
  z.string().min(1),
  z.enum(CHANNELS),
  z.string(),
]);

export function unsubscribeKey(encryptionKey: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', encryptionKey, '', HKDF_INFO, KEY_BYTES)
  );
}

function mac(key: Buffer, fields: string[]): string {
  return createHmac('sha256', key)
    .update(JSON.stringify(fields))
    .digest('base64url');
}

// A JSON array instead of '|'-joined fields, so separators inside ids cannot shift field boundaries.
export function signUnsubscribeToken(
  key: Buffer,
  target: UnsubscribeTarget
): string {
  const fields = [target.projectId, target.profileId, target.channel];
  return Buffer.from(JSON.stringify([...fields, mac(key, fields)])).toString(
    'base64url'
  );
}

export function verifyUnsubscribeToken(
  key: Buffer,
  token: string | null
): UnsubscribeTarget | null {
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = zToken.safeParse(decoded);
  if (!parsed.success) {
    return null;
  }
  const [projectId, profileId, channel, given] = parsed.data;
  const expected = Buffer.from(mac(key, [projectId, profileId, channel]));
  const actual = Buffer.from(given);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null;
  }
  return { projectId, profileId, channel };
}

export function createUnsubscribeUrlRenderer(
  cfg: Pick<MarketingConfig, 'encryptionKey' | 'publicUrl'>,
  publicUrlFor?: (projectId: string) => string | null | undefined
) {
  const key = unsubscribeKey(cfg.encryptionKey);
  return (projectId: string, profileId: string, channel: string): string => {
    const base = (publicUrlFor?.(projectId) ?? cfg.publicUrl).replace(
      /\/+$/,
      ''
    );
    const token = signUnsubscribeToken(key, {
      projectId,
      profileId,
      channel: z.enum(CHANNELS).parse(channel),
    });
    return `${base}/marketing/unsubscribe?t=${token}`;
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function page(title: string, content: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem">
<main><h1>${escapeHtml(title)}</h1>${content}</main>
</body>
</html>`;
  return new Response(html, { status: 200, headers: PAGE_HEADERS });
}

export function createUnsubscribeHandlers(deps: {
  sql: Queryable;
  encryptionKey: string;
  // Charged only for invalid tokens: a valid signed link always works, even from a shared or limited IP.
  invalidTokenLimiter: Pick<RateLimiter, 'limited' | 'take'>;
}) {
  const key = unsubscribeKey(deps.encryptionKey);

  function targetOf(url: URL, ip: string): UnsubscribeTarget {
    const target = verifyUnsubscribeToken(key, url.searchParams.get('t'));
    if (target) {
      return target;
    }
    if (deps.invalidTokenLimiter.limited(ip)) {
      throw new HttpError(429, 'too_many_requests');
    }
    deps.invalidTokenLimiter.take(ip);
    throw new HttpError(400, 'invalid_token');
  }

  return {
    // Link scanners prefetch GETs, so this only asks; opting out takes the POST.
    confirm(url: URL, ip: string): Response {
      const target = targetOf(url, ip);
      const token = url.searchParams.get('t') ?? '';
      return page(
        'Unsubscribe',
        `<p>Stop receiving ${escapeHtml(CHANNEL_LABELS[target.channel])} messages from us?</p>
<form method="post" action="?t=${escapeHtml(encodeURIComponent(token))}">
<input type="hidden" name="List-Unsubscribe" value="One-Click">
<button type="submit">Unsubscribe</button>
</form>`
      );
    },
    // RFC 8058 one-click. The signed token is the authority and the insert is idempotent, so the body
    // (urlencoded or multipart List-Unsubscribe=One-Click, or nothing) is not read.
    async optOut(url: URL, ip: string): Promise<Response> {
      const target = targetOf(url, ip);
      await deps.sql.$executeRawUnsafe(
        `INSERT INTO marketing.opt_outs (project_id, profile_id, channel)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        target.projectId,
        target.profileId,
        target.channel
      );
      return page(
        'Unsubscribed',
        `<p>You will no longer receive ${escapeHtml(CHANNEL_LABELS[target.channel])} messages from us.</p>`
      );
    },
  };
}
