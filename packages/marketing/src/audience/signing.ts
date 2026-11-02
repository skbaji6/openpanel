import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const SIGNATURE_WINDOW_SECONDS = 60;
const NONCE_BYTES = 16;
const BEARER_PREFIX = 'Bearer ';

interface SignInput {
  method: string;
  path: string;
  body: string;
  keyId: string;
  secret: string;
  timestamp: number;
  nonce: string;
}

type VerifyFailure =
  | 'missing'
  | 'unknown_key'
  | 'bad_signature'
  | 'stale'
  | 'replayed';

export type VerifyResult =
  | { ok: true; keyId: string }
  | { ok: false; reason: VerifyFailure };

const sha256Hex = (value: string) =>
  createHash('sha256').update(value).digest('hex');

function computeSignature(
  input: Pick<SignInput, 'method' | 'path' | 'nonce' | 'body'> & {
    timestamp: number | string;
  },
  secret: string
) {
  const canonical = `${input.method}\n${input.path}\n${input.timestamp}\n${input.nonce}\n${sha256Hex(input.body)}`;
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function newNonce() {
  return randomBytes(NONCE_BYTES).toString('hex');
}

export function signRequest(input: SignInput): Record<string, string> {
  return {
    Authorization: `${BEARER_PREFIX}${input.keyId}.${input.secret}`,
    'X-Timestamp': String(input.timestamp),
    'X-Nonce': input.nonce,
    'X-Signature': computeSignature(input, input.secret),
  };
}

function readHeader(headers: Headers | Record<string, string>, name: string) {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }
  return undefined;
}

export async function verifyRequest(input: {
  headers: Headers | Record<string, string>;
  method: string;
  path: string;
  body: string;
  keys: { id: string; secret: string }[];
  now: number;
  nonces: {
    seenBefore(nonce: string, ttlSeconds: number): Promise<boolean>;
  };
}): Promise<VerifyResult> {
  const authorization = readHeader(input.headers, 'authorization');
  const timestampHeader = readHeader(input.headers, 'x-timestamp');
  const nonce = readHeader(input.headers, 'x-nonce');
  const signature = readHeader(input.headers, 'x-signature');
  if (
    !(
      authorization?.startsWith(BEARER_PREFIX) &&
      timestampHeader &&
      nonce &&
      signature
    )
  ) {
    return { ok: false, reason: 'missing' };
  }

  const credential = authorization.slice(BEARER_PREFIX.length);
  const dot = credential.indexOf('.');
  const keyId = credential.slice(0, dot);
  const presentedSecret = credential.slice(dot + 1);
  const key = dot > 0 ? input.keys.find((k) => k.id === keyId) : undefined;
  if (!key) {
    return { ok: false, reason: 'unknown_key' };
  }

  const timestamp = Number(timestampHeader);
  const expected = computeSignature(
    { ...input, timestamp: timestampHeader, nonce },
    key.secret
  );
  const valid =
    safeEqual(presentedSecret, key.secret) && safeEqual(signature, expected);
  if (!valid) {
    return { ok: false, reason: 'bad_signature' };
  }

  if (
    !Number.isFinite(timestamp) ||
    Math.abs(input.now - timestamp) > SIGNATURE_WINDOW_SECONDS
  ) {
    return { ok: false, reason: 'stale' };
  }

  const replayed = await input.nonces.seenBefore(
    nonce,
    2 * SIGNATURE_WINDOW_SECONDS
  );
  return replayed
    ? { ok: false, reason: 'replayed' }
    : { ok: true, keyId: key.id };
}
