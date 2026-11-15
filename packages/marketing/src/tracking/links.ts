import type { CampaignChannel } from '../channels/settings';
import type { RenderedMessage } from '../channels/types';
import type { Queryable } from '../engine/engine';
import { MS_PER_DAY } from '../engine/engine';
import { linkKey } from './keys';
import type { TrackingSettings } from './settings';
import { LINK_TOKEN_TTL_DAYS, MAX_TOKEN_LENGTH, sealLinkToken } from './token';

export const MAX_TRACKED_LINKS = 20;
const MAX_URL_LENGTH = 2000;
const LINK_CACHE_SIZE = 5000;
const HREF_PATTERN = /href="([^"]*)"/g;
const HTTP_URL_PATTERN = /^https?:\/\//i;
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&lt;': '<',
  '&gt;': '>',
};

export interface TrackableLink {
  raw: string;
  url: string;
}

export const decodeEntities = (text: string) =>
  text.replace(
    /&(?:amp|quot|lt|gt|#39|#x27);/g,
    (entity) => ENTITIES[entity] ?? entity
  );

const isTrackable = (url: string) =>
  HTTP_URL_PATTERN.test(url) &&
  !url.includes('{{') &&
  url.length <= MAX_URL_LENGTH;

export function extractTrackableLinks(
  channel: CampaignChannel,
  template: { body: string; text?: string; link?: string }
): TrackableLink[] {
  const found = new Map<string, TrackableLink>();
  if (channel === 'email') {
    for (const match of template.body.matchAll(HREF_PATTERN)) {
      const raw = match[1] ?? '';
      const url = decodeEntities(raw);
      if (isTrackable(url) && !raw.includes('{{')) {
        found.set(raw, { raw, url });
      }
    }
  } else if (
    channel === 'push' &&
    template.link !== undefined &&
    isTrackable(template.link)
  ) {
    found.set(template.link, { raw: template.link, url: template.link });
  }
  return [...found.values()].slice(0, MAX_TRACKED_LINKS);
}

const REGISTER_SQL = `
  INSERT INTO marketing.tracked_links (id, project_id, url)
  SELECT gen_random_uuid(), $1::text, u FROM unnest($2::text[]) AS u
  ON CONFLICT (project_id, md5(url)) DO UPDATE SET url = EXCLUDED.url
  RETURNING id::text AS id, url`;

// shortcut: per process, evicts the oldest entry; ids never change for a (project, url), so a stale hit is harmless.
const linkIds = new Map<string, string>();
const cacheKey = (projectId: string, url: string) => `${projectId}\0${url}`;

function remember(projectId: string, url: string, id: string) {
  if (linkIds.size >= LINK_CACHE_SIZE) {
    const oldest = linkIds.keys().next().value;
    if (oldest !== undefined) {
      linkIds.delete(oldest);
    }
  }
  linkIds.set(cacheKey(projectId, url), id);
}

export async function registerLinks(
  sql: Queryable,
  projectId: string,
  links: TrackableLink[]
): Promise<Map<string, string>> {
  const idByUrl = new Map<string, string>();
  const missing = new Set<string>();
  for (const { url } of links) {
    const cached = linkIds.get(cacheKey(projectId, url));
    if (cached) {
      idByUrl.set(url, cached);
    } else {
      missing.add(url);
    }
  }
  if (missing.size > 0) {
    const rows = await sql.$queryRawUnsafe<{ id: string; url: string }[]>(
      REGISTER_SQL,
      projectId,
      [...missing]
    );
    for (const row of rows) {
      idByUrl.set(row.url, row.id);
      remember(projectId, row.url, row.id);
    }
  }
  const byRaw = new Map<string, string>();
  for (const { raw, url } of links) {
    const id = idByUrl.get(url);
    if (id) {
      byRaw.set(raw, id);
    }
  }
  return byRaw;
}

export const trackedUrl = (campaignUrl: string, token: string) =>
  `${campaignUrl}/marketing/r/${token}`;

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function rewriteMessageLinks(
  message: RenderedMessage,
  links: ReadonlyMap<string, string>,
  urlFor: (linkId: string) => string | undefined
): RenderedMessage {
  const next: RenderedMessage = { ...message };
  next.body = message.body.replace(HREF_PATTERN, (whole, raw: string) => {
    const id = links.get(raw);
    const url = id === undefined ? undefined : urlFor(id);
    return url === undefined ? whole : `href="${url}"`;
  });
  if (message.text !== undefined) {
    const idByUrl = new Map<string, string>();
    for (const [raw, id] of links) {
      idByUrl.set(decodeEntities(raw), id);
    }
    // One pass, longest first, so a url that is a prefix of another cannot garble it.
    const pattern = new RegExp(
      [...idByUrl.keys()]
        .sort((a, b) => b.length - a.length)
        .map(escapeRegExp)
        .join('|'),
      'g'
    );
    next.text =
      idByUrl.size === 0
        ? message.text
        : message.text.replace(pattern, (found) => {
            const id = idByUrl.get(found);
            return (id === undefined ? undefined : urlFor(id)) ?? found;
          });
  }
  const link = message.data?.link;
  const linkId = link === undefined ? undefined : links.get(link);
  const linkUrl = linkId === undefined ? undefined : urlFor(linkId);
  if (message.data && linkUrl !== undefined) {
    next.data = { ...message.data, link: linkUrl };
  }
  return next;
}

export interface TrackingPlan {
  campaignUrl: string;
  links: Map<string, string>;
  key: Buffer;
}

// Never throws: tracking is optional and a failure here must not touch a send that is already reserved.
export async function planTracking(
  sql: Queryable,
  options: {
    settings: TrackingSettings | undefined;
    encryptionKey: string;
    projectId: string;
    channel: CampaignChannel;
    template: () => { body: string; text?: string; link?: string };
  }
): Promise<TrackingPlan | null> {
  const campaignUrl = options.settings?.campaignUrl;
  if (!campaignUrl) {
    return null;
  }
  try {
    const trackable = extractTrackableLinks(
      options.channel,
      options.template()
    );
    if (trackable.length === 0) {
      return null;
    }
    const links = await registerLinks(sql, options.projectId, trackable);
    if (links.size === 0) {
      return null;
    }
    return {
      campaignUrl,
      links,
      key: linkKey(options.encryptionKey, options.projectId),
    };
  } catch {
    return null;
  }
}

// Never throws; a link that cannot be sealed within the length cap stays as written.
export function applyTracking(
  plan: TrackingPlan | null | undefined,
  options: { projectId: string; sourceRef: string; now: Date },
  message: RenderedMessage
): RenderedMessage {
  if (!plan) {
    return message;
  }
  try {
    const expiresAt = new Date(
      options.now.getTime() + LINK_TOKEN_TTL_DAYS * MS_PER_DAY
    );
    return rewriteMessageLinks(message, plan.links, (linkId) => {
      const token = sealLinkToken(plan.key, options.projectId, {
        sourceRef: options.sourceRef,
        linkId,
        expiresAt,
      });
      return token.length > MAX_TOKEN_LENGTH
        ? undefined
        : trackedUrl(plan.campaignUrl, token);
    });
  } catch {
    return message;
  }
}
