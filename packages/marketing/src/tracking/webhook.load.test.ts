import { beforeAll, describe, expect, it } from 'bun:test';
import type { LookupEntry } from '../audience/contract';
import type { AudienceSource } from '../audience/source';
import { smsReportFor } from '../channels/fakes/msg91-reports';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { webhookSecret } from './keys';
import { createReportMatcher } from './report-matcher';
import { createMsg91WebhookHandler } from './webhook';

const PROJECT = 'project-load';
const ENCRYPTION_KEY = 'b'.repeat(64);
const TOTAL = 20_000;
const REQUEST_IDS = 200;
const PER_REQUEST = TOTAL / REQUEST_IDS;
const CONCURRENCY = 50;
const SERVER_ERROR = 500;
const TEST_TIMEOUT_MS = 240_000;

const phoneOf = (index: number) => `9${String(index).padStart(9, '0')}`;

describe('msg91 webhook under a flood of single-report calls', () => {
  beforeAll(async () => {
    await migrate();
    await resetMarketingTables();
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.message_tracking (source_ref, project_id, profile_id, channel, status, provider_ref, sent_at, accepted_at)
       SELECT 'campaign:load:' || n, $1, 'student-' || n, 'sms', 'sent', 'req-' || (n / $3),
         now(), now()
       FROM generate_series(0, $2 - 1) AS n`,
      PROJECT,
      TOTAL,
      PER_REQUEST
    );
  }, TEST_TIMEOUT_MS);

  it(
    'looks each request id up once, delivers every row and never answers 5xx',
    async () => {
      let lookups = 0;
      const source = {
        lookup: async (ids: string[]) => {
          lookups++;
          await Bun.sleep(1);
          return ids.map(
            (id): LookupEntry => ({
              id,
              status: 'ok',
              phone: phoneOf(Number(id.slice('student-'.length))),
            })
          );
        },
      } as unknown as AudienceSource;
      const matcher = createReportMatcher({
        sql,
        sources: { forProject: async () => source },
      });
      const handler = createMsg91WebhookHandler({
        matcher,
        sql,
        encryptionKey: ENCRYPTION_KEY,
        failedAuthLimiter: { limited: () => false, take: () => true },
        log: { warn: () => undefined, error: () => undefined },
      });
      const secret = webhookSecret(ENCRYPTION_KEY, PROJECT);
      const statuses = new Map<number, number>();
      let next = 0;
      const worker = async () => {
        for (let index = next++; index < TOTAL; index = next++) {
          const body = smsReportFor(`req-${Math.floor(index / PER_REQUEST)}`, [
            { phone: `91${phoneOf(index)}`, status: '1' },
          ]);
          const response = await handler(
            PROJECT,
            secret,
            new Request('http://marketing.internal/hook', {
              method: 'POST',
              body: JSON.stringify(body),
            }),
            '10.0.0.1'
          );
          statuses.set(
            response.status,
            (statuses.get(response.status) ?? 0) + 1
          );
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));

      expect([...statuses.keys()].filter((s) => s >= SERVER_ERROR)).toEqual([]);
      expect(lookups).toBeLessThanOrEqual(REQUEST_IDS);
      const [row] = await sql.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM marketing.message_tracking
       WHERE project_id = $1 AND status = 'delivered'`,
        PROJECT
      );
      expect(row?.n).toBe(TOTAL);
    },
    TEST_TIMEOUT_MS
  );
});
