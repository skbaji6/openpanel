import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const LINK_TOKEN_TTL_DAYS = 90;
export const MAX_TOKEN_LENGTH = 512;

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MS_PER_SECOND = 1000;

export interface LinkTarget {
  sourceRef: string;
  linkId: string;
  expiresAt: Date;
}

export type OpenedToken =
  | { ok: true; projectId: string; target: LinkTarget }
  | { ok: false; reason: 'invalid' | 'expired' };

const INVALID: OpenedToken = { ok: false, reason: 'invalid' };

// The project id is the only readable part; it is also the AAD, so a token moved to another project fails the tag.
export function sealLinkToken(
  key: Buffer,
  projectId: string,
  target: LinkTarget
): string {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error('invalid project id');
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(projectId));
  const plain = JSON.stringify([
    target.sourceRef,
    target.linkId,
    Math.floor(target.expiresAt.getTime() / MS_PER_SECOND),
  ]);
  const sealed = Buffer.concat([
    iv,
    cipher.update(plain, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `${projectId}.${sealed.toString('base64url')}`;
}

function parseTarget(plain: string): LinkTarget | null {
  const value: unknown = JSON.parse(plain);
  if (!Array.isArray(value) || value.length !== 3) {
    return null;
  }
  const [sourceRef, linkId, seconds] = value as unknown[];
  if (
    typeof sourceRef !== 'string' ||
    typeof linkId !== 'string' ||
    typeof seconds !== 'number' ||
    !Number.isFinite(seconds)
  ) {
    return null;
  }
  return { sourceRef, linkId, expiresAt: new Date(seconds * MS_PER_SECOND) };
}

// Every failure before the tag verifies is the same generic 'invalid'; expiry is only judged on authentic tokens.
export function openLinkToken(
  keyFor: (projectId: string) => Buffer,
  token: string,
  now: Date
): OpenedToken {
  if (token.length > MAX_TOKEN_LENGTH) {
    return INVALID;
  }
  const dot = token.indexOf('.');
  const projectId = token.slice(0, dot);
  const encoded = token.slice(dot + 1);
  if (dot < 0 || !PROJECT_ID_PATTERN.test(projectId)) {
    return INVALID;
  }
  const sealed = Buffer.from(encoded, 'base64url');
  if (
    sealed.toString('base64url') !== encoded ||
    sealed.length <= IV_BYTES + TAG_BYTES
  ) {
    return INVALID;
  }
  let target: LinkTarget | null;
  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      keyFor(projectId),
      sealed.subarray(0, IV_BYTES)
    );
    decipher.setAAD(Buffer.from(projectId));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    const plain = Buffer.concat([
      decipher.update(sealed.subarray(IV_BYTES, sealed.length - TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
    target = parseTarget(plain);
  } catch {
    return INVALID;
  }
  if (!target) {
    return INVALID;
  }
  if (target.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, projectId, target };
}
