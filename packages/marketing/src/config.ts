import { z } from 'zod';
import { SENDING_LEASE_MS } from './campaign/recipients';

const SASL_MECHANISMS = ['plain', 'scram-sha-256', 'scram-sha-512'] as const;
const TRUE_VALUES = new Set(['true', '1']);
const FALSE_VALUES = new Set(['false', '0']);
// Connections a replica needs besides one per concurrent send and campaign loop: consumer batch, tick sweep/claim, HTTP.
const DB_POOL_HEADROOM = 3;
const MAX_CAMPAIGN_CONCURRENCY = 32;
// Time a campaign claim keeps for pacing after the lookup; below it a slow rate never fits a token in.
const DISPATCH_PACING_MARGIN_MS = 15_000;
// A claim must outlast the lookup batch window, the campaign sending lease (which also covers the journey
// ticker's send timeout and mark retries) and some pacing. A slower lookup is caught by the remaining-lease checks.
const minLeaseSeconds = (lookupWindowMs: number) =>
  (lookupWindowMs + SENDING_LEASE_MS + DISPATCH_PACING_MARGIN_MS) / 1000;
const WEB_PROTOCOLS = new Set(['http:', 'https:']);
const TRAILING_SLASHES = /\/+$/;

const blankToUndefined = (value: unknown) => {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

const optionalString = z.preprocess(blankToUndefined, z.string().optional());
const requiredString = z.preprocess(blankToUndefined, z.string());
const stringWithDefault = (fallback: string) =>
  z.preprocess(blankToUndefined, z.string().default(fallback));
const positiveInt = (fallback: number) =>
  z.preprocess(
    blankToUndefined,
    z.coerce.number().int().positive().default(fallback)
  );
const list = z.preprocess(
  blankToUndefined,
  z
    .string()
    .optional()
    .transform((value) =>
      (value ?? '')
        .split(',')
        .map((token) => token.trim())
        .filter(Boolean)
    )
);
// A typo must not silently turn TLS off, so anything but true/1/false/0 fails.
const optionalBoolean = z.preprocess(
  blankToUndefined,
  z
    .string()
    .refine((value) => TRUE_VALUES.has(value) || FALSE_VALUES.has(value), {
      message: 'must be true, 1, false or 0',
    })
    .transform((value) => TRUE_VALUES.has(value))
    .optional()
);

const rawSchema = z
  .object({
    DATABASE_URL: optionalString,
    // A dedicated database for the plugin; DATABASE_URL is used when unset.
    MARKETING_DATABASE_URL: optionalString,
    REDIS_URL: requiredString,
    ENCRYPTION_KEY: requiredString,
    MARKETING_PROXY_SECRET: requiredString,
    MARKETING_PUBLIC_URL: requiredString,
    MARKETING_PORT: positiveInt(4100),
    // Only behind a reverse proxy that appends the client address to x-forwarded-for.
    MARKETING_TRUST_PROXY: optionalBoolean,
    MARKETING_GRACE_SECONDS: positiveInt(300),
    MARKETING_MAX_LAG: positiveInt(1000),
    MARKETING_TICK_MS: positiveInt(5000),
    MARKETING_LEASE_SECONDS: positiveInt(120),
    MARKETING_EVENT_RETENTION_DAYS: positiveInt(30),
    MARKETING_CLAIM_BATCH: positiveInt(200),
    MARKETING_SEND_CONCURRENCY: positiveInt(10),
    MARKETING_CAMPAIGN_CONCURRENCY: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(1).max(MAX_CAMPAIGN_CONCURRENCY).default(2)
    ),
    MARKETING_DB_POOL: positiveInt(15),
    MARKETING_SOURCE_CONCURRENCY: positiveInt(4),
    MARKETING_LOOKUP_WINDOW_MS: positiveInt(2000),
    MARKETING_MAX_LATENESS: positiveInt(86_400),
    MARKETING_CONFIRM_THRESHOLD: positiveInt(5000),
    // Hostnames only, any port; IPv6 literals are unsupported because they contain ':'.
    MARKETING_WEBHOOK_ALLOW_HOSTS: list.refine(
      (hosts) => hosts.every((host) => !/[:/]/.test(host)),
      { message: 'entries must be bare hostnames (no scheme, port or path)' }
    ),
    MARKETING_KAFKA_GROUP: stringWithDefault('marketing'),
    KAFKA_BROKERS: list.refine((brokers) => brokers.length > 0, {
      message: 'at least one broker is required',
    }),
    KAFKA_CLIENT_ID: stringWithDefault('openpanel-marketing'),
    KAFKA_EVENTS_TOPIC: requiredString,
    KAFKA_SSL: optionalBoolean,
    KAFKA_SSL_CA_PATH: optionalString,
    KAFKA_SSL_REJECT_UNAUTHORIZED: optionalBoolean,
    KAFKA_SASL_USERNAME: optionalString,
    KAFKA_SASL_PASSWORD: optionalString,
    KAFKA_SASL_MECHANISM: z.preprocess(
      blankToUndefined,
      z.enum(SASL_MECHANISMS).default('scram-sha-512')
    ),
  })
  .superRefine((raw, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    // The value is a secret, so the message never echoes it.
    if (
      raw.DATABASE_URL === undefined &&
      raw.MARKETING_DATABASE_URL === undefined
    ) {
      issue('DATABASE_URL', 'set DATABASE_URL or MARKETING_DATABASE_URL');
    }
    for (const [name, value] of [
      ['DATABASE_URL', raw.DATABASE_URL],
      ['MARKETING_DATABASE_URL', raw.MARKETING_DATABASE_URL],
    ] as const) {
      if (value !== undefined && !URL.canParse(value)) {
        issue(
          name,
          'must be a URL such as postgresql://user:password@host:5432/database'
        );
      }
    }
    const publicUrl = URL.canParse(raw.MARKETING_PUBLIC_URL)
      ? new URL(raw.MARKETING_PUBLIC_URL)
      : null;
    if (!(publicUrl && WEB_PROTOCOLS.has(publicUrl.protocol))) {
      issue('MARKETING_PUBLIC_URL', 'must be an http(s) URL');
    }
    const minPool =
      raw.MARKETING_SEND_CONCURRENCY +
      raw.MARKETING_CAMPAIGN_CONCURRENCY +
      DB_POOL_HEADROOM;
    if (raw.MARKETING_DB_POOL < minPool) {
      issue(
        'MARKETING_DB_POOL',
        `must be at least MARKETING_SEND_CONCURRENCY + MARKETING_CAMPAIGN_CONCURRENCY + ${DB_POOL_HEADROOM} (${minPool})`
      );
    }
    const minLease = minLeaseSeconds(raw.MARKETING_LOOKUP_WINDOW_MS);
    if (raw.MARKETING_LEASE_SECONDS <= minLease) {
      issue(
        'MARKETING_LEASE_SECONDS',
        `must be greater than ${minLease} (MARKETING_LOOKUP_WINDOW_MS plus the ${SENDING_LEASE_MS / 1000} s campaign sending lease plus ${DISPATCH_PACING_MARGIN_MS / 1000} s of pacing)`
      );
    }
    const hasUsername = raw.KAFKA_SASL_USERNAME !== undefined;
    const hasPassword = raw.KAFKA_SASL_PASSWORD !== undefined;
    if (hasUsername === hasPassword) {
      return;
    }
    ctx.addIssue({
      code: 'custom',
      path: [hasUsername ? 'KAFKA_SASL_PASSWORD' : 'KAFKA_SASL_USERNAME'],
      message:
        'both KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD are required for SASL',
    });
  });

export interface KafkaConfig {
  brokers: string[];
  clientId: string;
  topic: string;
  groupId: string;
  ssl: boolean | { caPath?: string; rejectUnauthorized?: boolean };
  sasl?: {
    mechanism: (typeof SASL_MECHANISMS)[number];
    username: string;
    password: string;
  };
}

export interface MarketingConfig {
  databaseUrl: string;
  redisUrl: string;
  encryptionKey: string;
  proxySecret: string;
  publicUrl: string;
  port: number;
  trustProxy: boolean;
  graceSeconds: number;
  maxLag: number;
  tickMs: number;
  leaseSeconds: number;
  retentionDays: number;
  claimBatch: number;
  sendConcurrency: number;
  campaignConcurrency: number;
  dbPool: number;
  sourceConcurrency: number;
  lookupWindowMs: number;
  maxLatenessSeconds: number;
  confirmThreshold: number;
  webhookAllowHosts: string[];
  kafka: KafkaConfig;
}

function withConnectionLimit(databaseUrl: string, limit: number) {
  const url = new URL(databaseUrl);
  url.searchParams.set('connection_limit', String(limit));
  return url.toString();
}

export function loadConfig(
  env: Record<string, string | undefined>
): MarketingConfig {
  const parsed = rawSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid marketing configuration: ${issues}`);
  }
  const raw = parsed.data;
  const hasSasl =
    raw.KAFKA_SASL_USERNAME !== undefined &&
    raw.KAFKA_SASL_PASSWORD !== undefined;
  const tlsOptions =
    raw.KAFKA_SSL_CA_PATH !== undefined ||
    raw.KAFKA_SSL_REJECT_UNAUTHORIZED !== undefined
      ? {
          caPath: raw.KAFKA_SSL_CA_PATH,
          rejectUnauthorized: raw.KAFKA_SSL_REJECT_UNAUTHORIZED,
        }
      : true;
  // SASL credentials go over TLS unless KAFKA_SSL=false opts out.
  const sslEnabled = raw.KAFKA_SSL ?? hasSasl;

  return {
    databaseUrl: withConnectionLimit(
      (raw.MARKETING_DATABASE_URL ?? raw.DATABASE_URL) as string,
      raw.MARKETING_DB_POOL
    ),
    redisUrl: raw.REDIS_URL,
    encryptionKey: raw.ENCRYPTION_KEY,
    proxySecret: raw.MARKETING_PROXY_SECRET,
    publicUrl: raw.MARKETING_PUBLIC_URL.replace(TRAILING_SLASHES, ''),
    port: raw.MARKETING_PORT,
    trustProxy: raw.MARKETING_TRUST_PROXY ?? false,
    graceSeconds: raw.MARKETING_GRACE_SECONDS,
    maxLag: raw.MARKETING_MAX_LAG,
    tickMs: raw.MARKETING_TICK_MS,
    leaseSeconds: raw.MARKETING_LEASE_SECONDS,
    retentionDays: raw.MARKETING_EVENT_RETENTION_DAYS,
    claimBatch: raw.MARKETING_CLAIM_BATCH,
    sendConcurrency: raw.MARKETING_SEND_CONCURRENCY,
    campaignConcurrency: raw.MARKETING_CAMPAIGN_CONCURRENCY,
    dbPool: raw.MARKETING_DB_POOL,
    sourceConcurrency: raw.MARKETING_SOURCE_CONCURRENCY,
    lookupWindowMs: raw.MARKETING_LOOKUP_WINDOW_MS,
    maxLatenessSeconds: raw.MARKETING_MAX_LATENESS,
    confirmThreshold: raw.MARKETING_CONFIRM_THRESHOLD,
    webhookAllowHosts: raw.MARKETING_WEBHOOK_ALLOW_HOSTS,
    kafka: {
      brokers: raw.KAFKA_BROKERS,
      clientId: raw.KAFKA_CLIENT_ID,
      topic: raw.KAFKA_EVENTS_TOPIC,
      groupId: raw.MARKETING_KAFKA_GROUP,
      ssl: sslEnabled ? tlsOptions : false,
      sasl: hasSasl
        ? {
            mechanism: raw.KAFKA_SASL_MECHANISM,
            username: raw.KAFKA_SASL_USERNAME as string,
            password: raw.KAFKA_SASL_PASSWORD as string,
          }
        : undefined,
    },
  };
}
