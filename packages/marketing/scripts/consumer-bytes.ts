// Measures what the marketing consumer would read from the events topic and what its interest filter keeps,
// for the WAN-bandwidth decision (spec section 3.1). Read-only: own consumer group, never commits offsets.
// Usage: bun packages/marketing/scripts/consumer-bytes.ts [--seconds 60]
// Needs the worker's env (DATABASE_URL, REDIS_URL, KAFKA_BROKERS, KAFKA_EVENTS_TOPIC, ENCRYPTION_KEY).

import { getRedisCache } from '@openpanel/redis';
import { loadConfig } from '../src/config';
import { sql } from '../src/db/client';
import { createEngine } from '../src/engine/engine';
import { normalizeEvent } from '../src/events/normalize';
import { createKafka } from '../src/kafka/consumer';
import { createRedisInterestSet } from '../src/kafka/interest';

const DEFAULT_SECONDS = 60;
const PROBE_GROUP_ID = 'marketing-bytes-probe';
const MS_PER_SECOND = 1000;
const PERCENT = 100;
const BYTES_PER_KIB = 1024;
// Only the Kafka and database settings matter here; the rest satisfy the config schema.
const UNUSED_SETTINGS = {
  MARKETING_PROXY_SECRET: 'bandwidth-probe',
  MARKETING_PUBLIC_URL: 'http://localhost',
};

function parseSeconds(argv: string[]): number {
  const index = argv.indexOf('--seconds');
  const value = index === -1 ? DEFAULT_SECONDS : Number(argv[index + 1]);
  if (!(Number.isFinite(value) && value > 0)) {
    throw new Error('--seconds must be a positive number');
  }
  return value;
}

interface Tally {
  messages: number;
  bytes: number;
}

const tally = (): Tally => ({ messages: 0, bytes: 0 });

function add(target: Tally, bytes: number) {
  target.messages += 1;
  target.bytes += bytes;
}

function row(label: string, total: Tally, seconds: number): string[] {
  return [
    label,
    String(total.messages),
    (total.messages / seconds).toFixed(2),
    String(total.bytes),
    (total.bytes / seconds).toFixed(1),
  ];
}

function printTable(rows: string[][]) {
  const widths = rows[0]?.map((_cell, column) =>
    Math.max(...rows.map((cells) => cells[column]?.length ?? 0))
  );
  for (const cells of rows) {
    console.log(
      cells
        .map((cell, column) => cell.padStart(widths?.[column] ?? 0))
        .join('  ')
    );
  }
}

async function main() {
  const seconds = parseSeconds(process.argv.slice(2));
  const cfg = loadConfig({ ...UNUSED_SETTINGS, ...process.env });
  const redis = getRedisCache();
  const engine = createEngine({ sql });
  const interest = createRedisInterestSet(redis, { engine, sql });
  await interest.refresh();

  const consumed = tally();
  const withProfile = tally();
  const kept = tally();

  const consumer = createKafka(cfg.kafka).consumer({ groupId: PROBE_GROUP_ID });
  await consumer.connect();
  await consumer.subscribe({ topic: cfg.kafka.topic, fromBeginning: false });
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({ message }) => {
      if (message.value === null) {
        return;
      }
      const bytes = message.value.length;
      add(consumed, bytes);
      let payload: unknown = null;
      try {
        payload = JSON.parse(message.value.toString('utf8'));
      } catch {
        return;
      }
      const event = normalizeEvent(payload);
      if (event === null) {
        return;
      }
      add(withProfile, bytes);
      const [interesting] = await interest.hasMany([event]);
      if (interesting) {
        add(kept, bytes);
      }
    },
  });
  const started = Date.now();
  console.log(
    `probing topic "${cfg.kafka.topic}" for ${seconds} s as group ${PROBE_GROUP_ID} (offsets are not committed)`
  );
  await Bun.sleep(seconds * MS_PER_SECOND);
  const elapsed = (Date.now() - started) / MS_PER_SECOND;
  await consumer.disconnect();

  printTable([
    ['stage', 'events', 'events/s', 'bytes', 'bytes/s'],
    row('topic (all)', consumed, elapsed),
    row('identified', withProfile, elapsed),
    row('kept by filter', kept, elapsed),
  ]);
  const keptShare = consumed.bytes
    ? (kept.bytes / consumed.bytes) * PERCENT
    : 0;
  console.log(
    `kept share of topic bytes: ${keptShare.toFixed(1)}%; topic rate ${(consumed.bytes / elapsed / BYTES_PER_KIB).toFixed(2)} KiB/s over ${elapsed.toFixed(1)} s`
  );
  console.log(
    'the consumer reads the whole topic (all bytes cross the link); only kept events cost Postgres writes'
  );
}

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
