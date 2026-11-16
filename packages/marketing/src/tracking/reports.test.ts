import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import {
  campaignReport,
  journeyReport,
  MAX_REPORT_DAYS,
  NOT_REPORTED,
} from './reports';

const PROJECT = 'p1';
const OTHER_PROJECT = 'p2';
const KOLKATA = 'Asia/Kolkata';
const D1 = '2026-11-10T06:00:00Z';
const D2 = '2026-11-11T06:00:00Z';
const D3 = '2026-11-12T06:00:00Z';

interface Message {
  status: string;
  sentAt: string;
  accepted?: boolean;
  delivered?: string;
  read?: string;
  clicked?: string;
  converted?: string;
  failed?: string;
  channel?: string;
  stepIndex?: number;
}

async function insertCampaign(project = PROJECT, channel = 'sms') {
  const id = randomUUID();
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.campaigns (id, project_id, name, state, channel, template, confirm_threshold, created_by, materialize_state)
     VALUES ($1::uuid, $2, 'c', 'completed', $3, '{}'::jsonb, 5000, 'u', 'done')`,
    id,
    project,
    channel
  );
  return id;
}

async function insertRule(project = PROJECT) {
  const id = randomUUID();
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.rules (id, project_id, name, status, definition)
     VALUES ($1::uuid, $2, 'r', 'active', '{}'::jsonb)`,
    id,
    project
  );
  return id;
}

async function insertMessages(
  owner: { campaignId?: string; ruleId?: string },
  messages: Message[],
  project = PROJECT
) {
  for (const [index, m] of messages.entries()) {
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.message_tracking
        (source_ref, project_id, profile_id, channel, campaign_id, rule_id, step_index, status, sent_at,
         accepted_at, delivered_at, read_at, clicked_at, converted_at, failed_at)
       VALUES ($1, $2, $3, $4, $5::uuid, $6::uuid, $7, $8, $9::timestamptz,
         $10::timestamptz, $11::timestamptz, $12::timestamptz, $13::timestamptz, $14::timestamptz, $15::timestamptz)`,
      `${randomUUID()}:${index}`,
      project,
      `u${index}`,
      m.channel ?? null,
      owner.campaignId ?? null,
      owner.ruleId ?? null,
      m.stepIndex ?? null,
      m.status,
      m.sentAt,
      m.accepted === false ? null : m.sentAt,
      m.delivered ?? null,
      m.read ?? null,
      m.clicked ?? null,
      m.converted ?? null,
      m.failed ?? null
    );
  }
}

const TWELVE: Message[] = [
  { status: 'skipped', sentAt: D1, accepted: false },
  { status: 'uncertain', sentAt: D1, accepted: false },
  { status: 'sent', sentAt: D1 },
  { status: 'failed', sentAt: D1, accepted: false, failed: D1 },
  { status: 'failed', sentAt: D1, failed: D1 },
  { status: 'delivered', sentAt: D1, delivered: D1 },
  { status: 'read', sentAt: D1, delivered: D2, read: D2 },
  { status: 'clicked', sentAt: D1, clicked: D2 },
  { status: 'converted', sentAt: D1, converted: D3 },
  {
    status: 'converted',
    sentAt: D2,
    delivered: D2,
    read: D2,
    clicked: D2,
    converted: D3,
  },
  { status: 'sent', sentAt: D2 },
  { status: 'delivered', sentAt: D2, delivered: D2 },
];

beforeAll(migrate);
beforeEach(resetMarketingTables);

describe('campaignReport', () => {
  it('statuses, funnel and daily match a hand-built set of 12 messages', async () => {
    const campaignId = await insertCampaign();
    await insertMessages({ campaignId }, TWELVE);
    const report = await campaignReport(sql, PROJECT, campaignId, KOLKATA);
    expect(report?.channel).toBe('sms');
    expect(report?.statuses).toEqual({
      skipped: 1,
      uncertain: 1,
      sent: 2,
      failed: 2,
      delivered: 2,
      read: 1,
      clicked: 1,
      converted: 2,
    });
    expect(report?.funnel).toEqual({
      sent: 9,
      delivered: 4,
      read: 2,
      clicked: 2,
      converted: 2,
    });
    expect(report?.daily).toEqual([
      {
        day: '2026-11-10',
        sent: 6,
        delivered: 1,
        read: 0,
        clicked: 0,
        converted: 0,
        failed: 2,
        skipped: 1,
        uncertain: 1,
      },
      {
        day: '2026-11-11',
        sent: 3,
        delivered: 3,
        read: 2,
        clicked: 2,
        converted: 0,
        failed: 0,
        skipped: 0,
        uncertain: 0,
      },
      {
        day: '2026-11-12',
        sent: 0,
        delivered: 0,
        read: 0,
        clicked: 0,
        converted: 2,
        failed: 0,
        skipped: 0,
        uncertain: 0,
      },
    ]);
    expect(report?.notReported).toEqual(NOT_REPORTED.sms);
    expect(report?.conversion).toEqual({ event: null, windowDays: 7 });
  });

  it('a send-time failure is not in funnel.sent and a provider failure is', async () => {
    const campaignId = await insertCampaign();
    await insertMessages({ campaignId }, [
      { status: 'failed', sentAt: D1, accepted: false, failed: D1 },
    ]);
    expect(
      (await campaignReport(sql, PROJECT, campaignId, KOLKATA))?.funnel.sent
    ).toBe(0);
    await insertMessages({ campaignId }, [
      { status: 'failed', sentAt: D1, failed: D1 },
    ]);
    const report = await campaignReport(sql, PROJECT, campaignId, KOLKATA);
    expect(report?.funnel.sent).toBe(1);
    expect(report?.statuses.failed).toBe(2);
  });

  it('days are bucketed in the given time zone', async () => {
    const campaignId = await insertCampaign();
    await insertMessages({ campaignId }, [
      { status: 'sent', sentAt: '2026-11-10T20:00:00Z' },
    ]);
    const days = async (timeZone: string) =>
      (await campaignReport(sql, PROJECT, campaignId, timeZone))?.daily.map(
        (row) => row.day
      );
    expect(await days('UTC')).toEqual(['2026-11-10']);
    expect(await days(KOLKATA)).toEqual(['2026-11-11']);
    expect(await days('America/Los_Angeles')).toEqual(['2026-11-10']);
  });

  it('a campaign of another project is null', async () => {
    const campaignId = await insertCampaign(OTHER_PROJECT);
    await insertMessages({ campaignId }, TWELVE, OTHER_PROJECT);
    expect(await campaignReport(sql, PROJECT, campaignId, KOLKATA)).toBeNull();
    expect(
      await campaignReport(sql, PROJECT, randomUUID(), KOLKATA)
    ).toBeNull();
  });

  it('a report over 20,000 rows returns correct totals', async () => {
    const campaignId = await insertCampaign();
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.message_tracking
        (source_ref, project_id, profile_id, campaign_id, status, sent_at, accepted_at, delivered_at, read_at)
       SELECT 'load:' || i, $1, 'u' || i, $2::uuid,
         CASE i % 4 WHEN 0 THEN 'sent' WHEN 1 THEN 'delivered' WHEN 2 THEN 'read' ELSE 'skipped' END,
         d, CASE WHEN i % 4 = 3 THEN NULL ELSE d END,
         CASE WHEN i % 4 IN (1, 2) THEN d END, CASE WHEN i % 4 = 2 THEN d END
       FROM (SELECT i, '2026-01-01T06:00:00Z'::timestamptz + (i % 100) * interval '1 day' AS d
             FROM generate_series(1, 20000) AS i) AS g`,
      PROJECT,
      campaignId
    );
    const report = await campaignReport(sql, PROJECT, campaignId, KOLKATA);
    expect(report?.statuses.sent).toBe(5000);
    expect(report?.statuses.delivered).toBe(5000);
    expect(report?.statuses.read).toBe(5000);
    expect(report?.statuses.skipped).toBe(5000);
    expect(report?.funnel).toEqual({
      sent: 15_000,
      delivered: 10_000,
      read: 5000,
      clicked: 0,
      converted: 0,
    });
    expect(report?.daily).toHaveLength(MAX_REPORT_DAYS);
    const lastDay = report?.daily.at(-1);
    expect(lastDay?.day).toBe('2026-04-10');
    expect(report?.daily.reduce((sum, row) => sum + row.sent, 0)).toBe(13_400);
  });
});

describe('journeyReport', () => {
  it('a journey report has per-step funnels and per-variant rows', async () => {
    const ruleId = await insertRule();
    await insertMessages({ ruleId }, [
      { status: 'sent', sentAt: D1, channel: 'email', stepIndex: 0 },
      {
        status: 'clicked',
        sentAt: D1,
        channel: 'email',
        stepIndex: 0,
        clicked: D2,
      },
      {
        status: 'skipped',
        sentAt: D1,
        accepted: false,
        channel: 'push',
        stepIndex: 1,
      },
      { status: 'sent', sentAt: D2, channel: 'push', stepIndex: 1 },
    ]);
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.journey_variant_counts (project_id, rule_id, step_index, variant_key, day, sent, skipped, failed)
       VALUES ($1, $2::uuid, 0, 'TS', '2026-11-10', 2, 0, 0), ($1, $2::uuid, 0, 'TS', '2026-11-11', 1, 0, 1),
              ($1, $2::uuid, 0, '', '2026-11-10', 0, 3, 0)`,
      PROJECT,
      ruleId
    );
    const report = await journeyReport(sql, PROJECT, ruleId, KOLKATA);
    expect(report?.funnel).toEqual({
      sent: 3,
      delivered: 0,
      read: 0,
      clicked: 1,
      converted: 0,
    });
    expect(report?.steps.map((s) => [s.stepIndex, s.channel])).toEqual([
      [0, 'email'],
      [1, 'push'],
    ]);
    expect(report?.steps[0]?.funnel.sent).toBe(2);
    expect(report?.steps[0]?.funnel.clicked).toBe(1);
    expect(report?.steps[0]?.notReported).toEqual(NOT_REPORTED.email);
    expect(report?.steps[1]?.statuses.skipped).toBe(1);
    expect(report?.steps[1]?.funnel.sent).toBe(1);
    expect(report?.variants).toEqual([
      { stepIndex: 0, variantKey: '', sent: 0, skipped: 3, failed: 0 },
      { stepIndex: 0, variantKey: 'TS', sent: 3, skipped: 0, failed: 1 },
    ]);
  });

  it('a journey of another project is null', async () => {
    const ruleId = await insertRule(OTHER_PROJECT);
    expect(await journeyReport(sql, PROJECT, ruleId, KOLKATA)).toBeNull();
  });
});
