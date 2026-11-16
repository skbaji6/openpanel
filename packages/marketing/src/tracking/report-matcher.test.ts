import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { LookupChannel, LookupEntry } from '../audience/contract';
import type { AudienceSource } from '../audience/source';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { applyDeliveryUpdates } from './delivery';
import type { ParsedReport } from './msg91-reports';
import {
  createReportMatcher,
  HOLD_MS,
  MAX_HELD_REPORTS,
} from './report-matcher';

const PROJECT = 'p1';
const SENT_AT = '2026-11-15T09:00:00Z';
const AT = new Date('2026-11-15T10:00:00Z');
const COUNTRY_CODE = '91';

const phoneOf = (index: number) => `9${String(index).padStart(9, '0')}`;
const profileOf = (index: number) => `student-${index}`;
const refOf = (index: number) => `campaign:c1:${profileOf(index)}`;

async function insertRow(
  index: number,
  requestId: string | null,
  channel: string | null = 'sms',
  project = PROJECT
) {
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.message_tracking (source_ref, project_id, profile_id, channel, status, provider_ref, sent_at, accepted_at)
     VALUES ($1, $2, $3, $4, 'sent', $5, $6::timestamptz, $6::timestamptz)`,
    refOf(index),
    project,
    profileOf(index),
    channel,
    requestId,
    SENT_AT
  );
}

function fakeSources(phones: Map<string, string>) {
  const state = { lookups: 0, failNext: false };
  const source = {
    lookup: async (ids: string[], _channel: LookupChannel) => {
      state.lookups++;
      await Bun.sleep(1);
      if (state.failNext) {
        state.failNext = false;
        throw new Error('source down');
      }
      return ids.map(
        (id): LookupEntry =>
          phones.has(id)
            ? { id, status: 'ok', phone: phones.get(id) }
            : { id, status: 'not_found' }
      );
    },
  } as unknown as AudienceSource;
  return { state, sources: { forProject: async () => source } };
}

const allPhones = (count: number) =>
  new Map(
    Array.from({ length: count }, (_, i) => [profileOf(i), phoneOf(i)] as const)
  );

const report = (
  requestId: string,
  number: string,
  status: ParsedReport['status'] = 'delivered'
): ParsedReport => ({ requestId, number, status, at: AT, reason: null });

async function statusOf(index: number) {
  const [row] = await sql.$queryRawUnsafe<{ status: string }[]>(
    'SELECT status FROM marketing.message_tracking WHERE source_ref = $1',
    refOf(index)
  );
  return row?.status;
}

describe('report matcher', () => {
  beforeAll(async () => {
    await migrate();
  });
  beforeEach(resetMarketingTables);

  it('reports for 3 of 100 phones in one batch match exactly those rows', async () => {
    for (let i = 0; i < 100; i++) {
      await insertRow(i, 'req-1');
    }
    const { sources } = fakeSources(allPhones(100));
    const matcher = createReportMatcher({ sql, sources });
    const result = await matcher.match(
      PROJECT,
      [3, 40, 99].map((i) => report('req-1', `${COUNTRY_CODE}${phoneOf(i)}`))
    );
    expect(result.unmatched).toBe(0);
    expect(result.updates.map((u) => u.sourceRef).sort()).toEqual(
      [3, 40, 99].map(refOf).sort()
    );
  });

  it('a number with a country code matches a stored 10-digit phone and vice versa', async () => {
    await insertRow(1, 'req-1');
    await insertRow(2, 'req-1');
    const { sources } = fakeSources(
      new Map([
        [profileOf(1), phoneOf(1)],
        [profileOf(2), `+${COUNTRY_CODE} ${phoneOf(2)}`],
      ])
    );
    const matcher = createReportMatcher({ sql, sources });
    const result = await matcher.match(PROJECT, [
      report('req-1', `${COUNTRY_CODE}${phoneOf(1)}`),
      report('req-1', phoneOf(2)),
    ]);
    expect(result.updates.map((u) => u.sourceRef).sort()).toEqual([
      refOf(1),
      refOf(2),
    ]);
  });

  it('a second call for the same request id makes no lookup', async () => {
    await insertRow(1, 'req-1');
    const { state, sources } = fakeSources(allPhones(2));
    const matcher = createReportMatcher({ sql, sources });
    await matcher.match(PROJECT, [report('req-1', phoneOf(1))]);
    await matcher.match(PROJECT, [report('req-1', phoneOf(1), 'read')]);
    expect(state.lookups).toBe(1);
  });

  it('concurrent calls for one request id share one lookup', async () => {
    await insertRow(1, 'req-1');
    const { state, sources } = fakeSources(allPhones(2));
    const matcher = createReportMatcher({ sql, sources });
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        matcher.match(PROJECT, [report('req-1', phoneOf(1))])
      )
    );
    expect(state.lookups).toBe(1);
    expect(results.every((r) => r.updates.length === 1)).toBe(true);
  });

  it('a failed lookup is not cached', async () => {
    await insertRow(1, 'req-1');
    const { state, sources } = fakeSources(allPhones(2));
    const matcher = createReportMatcher({ sql, sources });
    state.failNext = true;
    await expect(
      matcher.match(PROJECT, [report('req-1', phoneOf(1))])
    ).rejects.toThrow();
    const result = await matcher.match(PROJECT, [report('req-1', phoneOf(1))]);
    expect(result.updates).toHaveLength(1);
  });

  it('a phone no longer returned by the source is unmatched', async () => {
    await insertRow(1, 'req-1');
    await insertRow(2, 'req-1');
    const { sources } = fakeSources(new Map([[profileOf(1), phoneOf(1)]]));
    const matcher = createReportMatcher({ sql, sources });
    const result = await matcher.match(PROJECT, [
      report('req-1', phoneOf(1)),
      report('req-1', phoneOf(2)),
    ]);
    expect(result.updates).toHaveLength(1);
    expect(result.unmatched).toBe(1);
  });

  it('a 9-digit number never matches', async () => {
    await insertRow(1, 'req-1');
    const nine = '987654321';
    const { sources } = fakeSources(new Map([[profileOf(1), nine]]));
    const matcher = createReportMatcher({ sql, sources });
    const result = await matcher.match(PROJECT, [report('req-1', nine)]);
    expect(result.updates).toHaveLength(0);
    expect(result.unmatched).toBe(1);
  });

  it('a report that arrives before the mark commits is held and applied by flushHeld once the row exists', async () => {
    const { state, sources } = fakeSources(allPhones(2));
    const matcher = createReportMatcher({ sql, sources });
    const early = await matcher.match(PROJECT, [report('req-1', phoneOf(1))]);
    expect(early).toEqual({ updates: [], unmatched: 0 });
    expect(matcher.heldStats().held).toBe(1);
    expect(await matcher.flushHeld()).toBe(0);
    expect(matcher.heldStats().held).toBe(1);

    await insertRow(1, 'req-1');
    expect(await matcher.flushHeld()).toBe(1);
    expect(await statusOf(1)).toBe('delivered');
    expect(matcher.heldStats()).toEqual({ held: 0, dropped: 0 });
    expect(state.lookups).toBe(1);
  });

  it('held reports past HOLD_MS are dropped and counted', async () => {
    let clock = 1_000_000;
    const { sources } = fakeSources(allPhones(2));
    const logged: string[] = [];
    const matcher = createReportMatcher({
      sql,
      sources,
      now: () => clock,
      log: (message) => logged.push(message),
    });
    await matcher.match(PROJECT, [report('req-1', phoneOf(1))]);
    clock += HOLD_MS + 1;
    await insertRow(1, 'req-1');
    expect(await matcher.flushHeld()).toBe(0);
    expect(matcher.heldStats()).toEqual({ held: 0, dropped: 1 });
    expect(await statusOf(1)).toBe('sent');
    expect(logged).toEqual(['msg91 early reports dropped: 1 (expired)']);
  });

  it('the hold is bounded', async () => {
    const { sources } = fakeSources(new Map());
    const matcher = createReportMatcher({ sql, sources });
    await matcher.match(
      PROJECT,
      Array.from({ length: MAX_HELD_REPORTS + 5 }, (_, i) =>
        report('req-1', phoneOf(i))
      )
    );
    expect(matcher.heldStats()).toEqual({ held: MAX_HELD_REPORTS, dropped: 5 });
  });

  it('the request cache is bounded by maxRequests', async () => {
    for (let i = 1; i <= 3; i++) {
      await insertRow(i, `req-${i}`);
    }
    const { state, sources } = fakeSources(allPhones(4));
    const matcher = createReportMatcher({ sql, sources, maxRequests: 2 });
    for (const i of [1, 2, 3, 1]) {
      await matcher.match(PROJECT, [report(`req-${i}`, phoneOf(i))]);
    }
    expect(state.lookups).toBe(4);
  });

  it('two concurrent calls with the same reports in different orders both succeed', async () => {
    const count = 200;
    for (let i = 0; i < count; i++) {
      await insertRow(i, 'req-1');
    }
    const { sources } = fakeSources(allPhones(count));
    const matcher = createReportMatcher({ sql, sources });
    const forward = Array.from({ length: count }, (_, i) =>
      report('req-1', phoneOf(i))
    );
    const call = async (reports: ParsedReport[]) => {
      const { updates } = await matcher.match(PROJECT, reports);
      return await applyDeliveryUpdates(sql, PROJECT, updates);
    };
    const applied = await Promise.all([
      call(forward),
      call([...forward].reverse()),
    ]);
    expect(applied[0] + applied[1]).toBe(count);
    expect(await statusOf(0)).toBe('delivered');
    expect(await statusOf(count - 1)).toBe('delivered');
  });
});
