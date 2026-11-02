// End-to-end proof against a running stack: API (POST /track) -> Kafka -> marketing worker -> webhook.
// Usage and prerequisites: packages/marketing/README.md, "End-to-end check".

import { SQL } from 'bun';
import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

const TRIGGER_EVENT = 'add_to_cart';
const GOAL_EVENT = 'purchase';
const STEP_DELAY_SECONDS = 10;
const DELIVERY_TIMEOUT_MS = 90_000;
// After the first delivery, how long to keep listening for a duplicate.
const DUPLICATE_WINDOW_MS = 15_000;
// Step delay + grace + a few ticks: no delivery by then means the goal cancelled it.
const CANCEL_WAIT_MS = 40_000;
const POLL_MS = 1000;
const GOAL_AFTER_TRIGGER_MS = 1000;
const E2E_USER_ID = 'marketing-e2e';
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0 Safari/537.36';

interface Delivery {
  timestamp: string;
  signature: string;
  rawBody: string;
  profileId: unknown;
  ruleId: unknown;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const env = {
  marketingUrl: process.env.MARKETING_URL?.trim() || 'http://localhost:4100',
  proxySecret: requireEnv('MARKETING_PROXY_SECRET'),
  apiUrl: requireEnv('API_URL'),
  projectId: requireEnv('E2E_PROJECT_ID'),
  clientId: requireEnv('E2E_CLIENT_ID'),
  clientSecret: requireEnv('E2E_CLIENT_SECRET'),
  // Must be listed in the worker's MARKETING_WEBHOOK_ALLOW_HOSTS (plain http is only allowed for those).
  receiverHost: process.env.E2E_RECEIVER_HOST?.trim() || 'localhost',
  databaseUrl: process.env.DATABASE_URL?.trim() || undefined,
  allowWebhookOverwrite: process.env.E2E_ALLOW_WEBHOOK_OVERWRITE === 'true',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function marketing(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {
    'x-marketing-proxy-secret': env.proxySecret,
    'x-marketing-project-id': env.projectId,
    'x-marketing-user-id': E2E_USER_ID,
  };
  if (method !== 'GET') {
    headers['x-marketing-csrf'] = '1';
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(
    new URL(`/marketing/${path}`, env.marketingUrl),
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${method} /marketing/${path} -> ${response.status} ${text}`
    );
  }
  return JSON.parse(text) as Record<string, unknown>;
}

async function track(name: string, profileId: string) {
  const response = await fetch(new URL('/track', env.apiUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'openpanel-client-id': env.clientId,
      'openpanel-client-secret': env.clientSecret,
      'user-agent': BROWSER_USER_AGENT,
      'x-client-ip': '81.2.69.142',
    },
    body: JSON.stringify({
      type: 'track',
      payload: { name, profileId, properties: {} },
    }),
  });
  if (!response.ok) {
    throw new Error(`POST /track ${name} -> ${response.status}`);
  }
}

function parseObject(rawBody: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    const isObject =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
    return isObject ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function startReceiver(deliveries: Delivery[], malformed: string[]) {
  const isLocal = env.receiverHost === 'localhost';
  return Bun.serve({
    port: 0,
    hostname: isLocal ? '127.0.0.1' : '0.0.0.0',
    async fetch(req) {
      const rawBody = await req.text();
      const parsed = parseObject(rawBody);
      if (!parsed) {
        malformed.push(`${req.method} ${new URL(req.url).pathname}`);
        return new Response('body is not a JSON object', { status: 400 });
      }
      deliveries.push({
        timestamp: req.headers.get('x-marketing-timestamp') ?? '',
        signature: req.headers.get('x-marketing-signature') ?? '',
        rawBody,
        profileId: parsed.profileId,
        ruleId: parsed.ruleId,
      });
      return new Response('ok');
    },
  });
}

function signatureVerifies(delivery: Delivery, secret: string): boolean {
  const expected = `sha256=${createHmac('sha256', secret)
    .update(`${delivery.timestamp}.${delivery.rawBody}`)
    .digest('hex')}`;
  const given = Buffer.from(delivery.signature);
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

async function waitFor(condition: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return true;
    }
    await sleep(POLL_MS);
  }
  return condition();
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`FAIL ${message}`);
  }
}

// The API cannot remove enrollments, steps or stored events, so they go by SQL when DATABASE_URL is given.
async function deleteMarketingRows(ruleId: string, profileIds: string[]) {
  if (!env.databaseUrl) {
    console.warn(
      'cleanup: DATABASE_URL unset; marketing rows for the e2e profiles stay until retention'
    );
    return;
  }
  const db = new SQL(env.databaseUrl);
  try {
    await db`DELETE FROM marketing.steps WHERE enrollment_id IN
      (SELECT id FROM marketing.enrollments WHERE rule_id = ${ruleId}::uuid)`;
    await db`DELETE FROM marketing.enrollments WHERE rule_id = ${ruleId}::uuid`;
    await db`DELETE FROM marketing.events WHERE project_id = ${env.projectId}
      AND profile_id IN ${db(profileIds)}`;
  } finally {
    await db.close();
  }
}

function redact(message: string): string {
  const secrets = [env.databaseUrl, env.proxySecret, env.clientSecret];
  let redacted = message;
  for (const secret of secrets) {
    if (secret) {
      redacted = redacted.replaceAll(secret, '[redacted]');
    }
  }
  return redacted;
}

function messageOf(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}

// Never throws: every step runs even if an earlier one failed, and a failed assertion stays the reported error.
async function cleanUp(ruleId: string, profileIds: string[]): Promise<boolean> {
  const steps: [string, () => Promise<unknown>][] = [
    ['delete rule', () => marketing('DELETE', `rules/${ruleId}`)],
    ['delete marketing rows', () => deleteMarketingRows(ruleId, profileIds)],
  ];
  let clean = true;
  for (const [label, step] of steps) {
    try {
      await step();
    } catch (error) {
      clean = false;
      console.error(`cleanup: ${label} failed: ${messageOf(error)}`);
    }
  }
  return clean;
}

async function main() {
  const existing = await marketing('GET', 'channels/webhook');
  if (existing.configured === true && !env.allowWebhookOverwrite) {
    throw new Error(
      'project already has a webhook channel; use a dedicated project or set E2E_ALLOW_WEBHOOK_OVERWRITE=true'
    );
  }

  const deliveries: Delivery[] = [];
  const malformed: string[] = [];
  const receiver = startReceiver(deliveries, malformed);
  const assertWellFormed = () =>
    assert(
      malformed.length === 0,
      `receiver got bodies that are not JSON objects: ${malformed.join(', ')}`
    );
  const webhookSecret = randomBytes(24).toString('hex');
  const runId = randomUUID().slice(0, 8);
  const deliveredProfile = `marketing-e2e-${runId}-a`;
  const cancelledProfile = `marketing-e2e-${runId}-b`;
  let ruleId: string | undefined;
  let cleanedUp = true;

  try {
    await marketing('PUT', 'channels/webhook', {
      config: {
        url: `http://${env.receiverHost}:${receiver.port}/hook`,
        secrets: [webhookSecret],
      },
    });
    const rule = await marketing('POST', 'rules', {
      status: 'active',
      definition: {
        name: `e2e ${runId}`,
        trigger: { event: TRIGGER_EVENT },
        goal: { kind: 'event', event: GOAL_EVENT },
        steps: [
          {
            delaySeconds: STEP_DELAY_SECONDS,
            channel: 'webhook',
            template: { body: 'marketing e2e' },
          },
        ],
        reentry: { enabled: false, cooldownSeconds: 0 },
        allowedEventProps: [],
      },
    });
    ruleId = String(rule.id);
    const forProfile = (profileId: string) =>
      deliveries.filter((delivery) => delivery.profileId === profileId);

    await track(TRIGGER_EVENT, deliveredProfile);
    const delivered = await waitFor(
      () => forProfile(deliveredProfile).length > 0,
      DELIVERY_TIMEOUT_MS
    );
    assertWellFormed();
    assert(delivered, `no delivery within ${DELIVERY_TIMEOUT_MS} ms`);
    await sleep(DUPLICATE_WINDOW_MS);
    const [delivery, ...duplicates] = forProfile(deliveredProfile);
    assert(
      delivery !== undefined && duplicates.length === 0,
      `expected 1 delivery, got ${1 + duplicates.length}`
    );
    assert(delivery.ruleId === ruleId, 'delivery carries another rule id');
    console.log('PASS delivered once');
    assert(
      signatureVerifies(delivery, webhookSecret),
      'x-marketing-signature does not verify against the channel secret'
    );
    console.log('PASS signature verifies');

    await track(TRIGGER_EVENT, cancelledProfile);
    await sleep(GOAL_AFTER_TRIGGER_MS);
    await track(GOAL_EVENT, cancelledProfile);
    await sleep(CANCEL_WAIT_MS);
    const results = await marketing('GET', `results?ruleId=${ruleId}`);
    const [ruleResult] = results.results as { enrolled: number }[];
    // Two enrollments prove the second trigger arrived, so zero deliveries is the goal's doing.
    assert(
      ruleResult?.enrolled === 2,
      `expected 2 enrollments, got ${ruleResult?.enrolled}`
    );
    assertWellFormed();
    const cancelledDeliveries = forProfile(cancelledProfile).length;
    assert(
      cancelledDeliveries === 0,
      `expected 0 deliveries after the goal, got ${cancelledDeliveries}`
    );
    console.log('PASS cancelled by goal');
  } finally {
    receiver.stop(true);
    if (ruleId) {
      cleanedUp = await cleanUp(ruleId, [deliveredProfile, cancelledProfile]);
    }
  }
  if (!cleanedUp) {
    throw new Error('cleanup failed; see the messages above');
  }
}

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error(messageOf(error));
  process.exit(1);
}
