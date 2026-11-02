import type { Admin } from 'kafkajs';
import type { KafkaConfig } from '../config';
import type { Queryable } from '../engine/engine';
import { createKafka } from './consumer';

export const LAG_REPORT_INTERVAL_MS = 10_000;
const NO_COMMITTED_OFFSET = -1;

// updated_at is written from the same JS clock runTick compares it against.
const UPSERT_LAG_SQL = `
  INSERT INTO marketing.consumer_state (id, lag, updated_at) VALUES (1, $1::bigint, $2::timestamptz)
  ON CONFLICT (id) DO UPDATE SET lag = EXCLUDED.lag, updated_at = EXCLUDED.updated_at`;

// A partition the group has never committed is measured from the end offset it had when first
// seen, so a consumer stuck on its first batch still shows growing lag. Mutates baselines.
export function computeLag(
  topicOffsets: { partition: number; offset: string }[],
  groupOffsets: { partition: number; offset: string }[],
  baselines: Map<number, number>
): number {
  const committed = new Map(
    groupOffsets.map((entry) => [entry.partition, Number(entry.offset)])
  );
  let lag = 0;
  for (const { partition, offset } of topicOffsets) {
    const end = Number(offset);
    const position = committed.get(partition) ?? NO_COMMITTED_OFFSET;
    if (position !== NO_COMMITTED_OFFSET) {
      baselines.delete(partition);
      lag += Math.max(0, end - position);
      continue;
    }
    const baseline = baselines.get(partition) ?? end;
    baselines.set(partition, baseline);
    lag += Math.max(0, end - baseline);
  }
  return lag;
}

export async function writeLagState(
  sql: Queryable,
  lag: number,
  now: Date
): Promise<void> {
  await sql.$executeRawUnsafe(UPSERT_LAG_SQL, lag, now.toISOString());
}

export function createLagReporter(deps: {
  kafka: KafkaConfig;
  sql: Queryable;
  now: () => Date;
}): { report(): Promise<number>; stop(): Promise<void> } {
  let admin: Admin | null = null;
  const baselines = new Map<number, number>();

  async function connectedAdmin(): Promise<Admin> {
    if (!admin) {
      const created = createKafka(deps.kafka).admin();
      await created.connect();
      admin = created;
    }
    return admin;
  }

  return {
    async report() {
      const client = await connectedAdmin();
      const [topicOffsets, [group]] = await Promise.all([
        client.fetchTopicOffsets(deps.kafka.topic),
        client.fetchOffsets({
          groupId: deps.kafka.groupId,
          topics: [deps.kafka.topic],
        }),
      ]);
      const lag = computeLag(topicOffsets, group?.partitions ?? [], baselines);
      await writeLagState(deps.sql, lag, deps.now());
      return lag;
    },
    async stop() {
      await admin?.disconnect();
      admin = null;
    },
  };
}
