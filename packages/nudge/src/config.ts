import { z } from 'zod';

const SASL_MECHANISMS = ['plain', 'scram-sha-256', 'scram-sha-512'] as const;
const TRUE_VALUES = new Set(['true', '1']);
const FALSE_VALUES = new Set(['false', '0']);

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
    DATABASE_URL: requiredString,
    REDIS_URL: requiredString,
    ENCRYPTION_KEY: requiredString,
    NUDGE_PROXY_SECRET: requiredString,
    NUDGE_PUBLIC_URL: requiredString,
    NUDGE_PORT: positiveInt(4100),
    NUDGE_GRACE_SECONDS: positiveInt(300),
    NUDGE_MAX_LAG: positiveInt(1000),
    NUDGE_TICK_MS: positiveInt(5000),
    NUDGE_LEASE_SECONDS: positiveInt(120),
    NUDGE_EVENT_RETENTION_DAYS: positiveInt(30),
    NUDGE_CLAIM_BATCH: positiveInt(200),
    NUDGE_SEND_CONCURRENCY: positiveInt(10),
    NUDGE_DB_POOL: positiveInt(10),
    // Hostnames only, any port; IPv6 literals are unsupported because they contain ':'.
    NUDGE_WEBHOOK_ALLOW_HOSTS: list.refine(
      (hosts) => hosts.every((host) => !/[:/]/.test(host)),
      { message: 'entries must be bare hostnames (no scheme, port or path)' }
    ),
    NUDGE_KAFKA_GROUP: stringWithDefault('nudge'),
    KAFKA_BROKERS: list.refine((brokers) => brokers.length > 0, {
      message: 'at least one broker is required',
    }),
    KAFKA_CLIENT_ID: stringWithDefault('openpanel-nudge'),
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

export interface NudgeConfig {
  databaseUrl: string;
  redisUrl: string;
  encryptionKey: string;
  proxySecret: string;
  publicUrl: string;
  port: number;
  graceSeconds: number;
  maxLag: number;
  tickMs: number;
  leaseSeconds: number;
  retentionDays: number;
  claimBatch: number;
  sendConcurrency: number;
  dbPool: number;
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
): NudgeConfig {
  const parsed = rawSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid nudge configuration: ${issues}`);
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
    databaseUrl: withConnectionLimit(raw.DATABASE_URL, raw.NUDGE_DB_POOL),
    redisUrl: raw.REDIS_URL,
    encryptionKey: raw.ENCRYPTION_KEY,
    proxySecret: raw.NUDGE_PROXY_SECRET,
    publicUrl: raw.NUDGE_PUBLIC_URL,
    port: raw.NUDGE_PORT,
    graceSeconds: raw.NUDGE_GRACE_SECONDS,
    maxLag: raw.NUDGE_MAX_LAG,
    tickMs: raw.NUDGE_TICK_MS,
    leaseSeconds: raw.NUDGE_LEASE_SECONDS,
    retentionDays: raw.NUDGE_EVENT_RETENTION_DAYS,
    claimBatch: raw.NUDGE_CLAIM_BATCH,
    sendConcurrency: raw.NUDGE_SEND_CONCURRENCY,
    dbPool: raw.NUDGE_DB_POOL,
    webhookAllowHosts: raw.NUDGE_WEBHOOK_ALLOW_HOSTS,
    kafka: {
      brokers: raw.KAFKA_BROKERS,
      clientId: raw.KAFKA_CLIENT_ID,
      topic: raw.KAFKA_EVENTS_TOPIC,
      groupId: raw.NUDGE_KAFKA_GROUP,
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
