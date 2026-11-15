import type { CampaignChannel } from '../channels/settings';
import type { Queryable } from '../engine/engine';
import { getTrackingSettings } from './settings';
import type { MessageStatus } from './status';

export const MAX_REPORT_DAYS = 90;

export type StatusCounts = Record<MessageStatus, number>;
type Reportable = 'delivered' | 'read' | 'clicked';

export interface Funnel {
  sent: number;
  delivered: number;
  read: number;
  clicked: number;
  converted: number;
}

export interface DailyRow extends Funnel {
  day: string;
  failed: number;
  skipped: number;
  uncertain: number;
}

// Milestones a channel's provider never reports, so the dashboard shows "not reported" rather than 0.
export const NOT_REPORTED: Record<CampaignChannel, Reportable[]> = {
  push: ['delivered', 'read'],
  email: ['delivered', 'read'],
  sms: ['read', 'clicked'],
  whatsapp: ['clicked'],
  webhook: ['delivered', 'read', 'clicked'],
};

interface Conversion {
  event: string | null;
  windowDays: number;
}

export interface CampaignReport {
  campaignId: string;
  channel: CampaignChannel;
  statuses: StatusCounts;
  funnel: Funnel;
  daily: DailyRow[];
  notReported: Reportable[];
  conversion: Conversion;
}

export interface JourneyReport {
  ruleId: string;
  statuses: StatusCounts;
  funnel: Funnel;
  daily: DailyRow[];
  steps: {
    stepIndex: number;
    channel: string | null;
    statuses: StatusCounts;
    funnel: Funnel;
    notReported: Reportable[];
  }[];
  variants: {
    stepIndex: number;
    variantKey: string;
    sent: number;
    skipped: number;
    failed: number;
  }[];
  conversion: Conversion;
}

// The column is a fixed literal chosen by the caller, never user input.
type Owner = 'campaign_id' | 'rule_id';

const FUNNEL_COLUMNS = `
  count(accepted_at)::int AS sent, count(delivered_at)::int AS delivered,
  count(read_at)::int AS read, count(clicked_at)::int AS clicked,
  count(converted_at)::int AS converted`;

// Params: project, owner id, time zone. Every milestone is one event row, so one pass buckets them all.
const dailySql = (owner: Owner) => `
  WITH scoped AS (
    SELECT * FROM marketing.message_tracking WHERE project_id = $1 AND ${owner} = $2::uuid
  ), events AS (
    SELECT accepted_at AS at, 'sent' AS kind FROM scoped WHERE accepted_at IS NOT NULL
    UNION ALL SELECT delivered_at, 'delivered' FROM scoped WHERE delivered_at IS NOT NULL
    UNION ALL SELECT read_at, 'read' FROM scoped WHERE read_at IS NOT NULL
    UNION ALL SELECT clicked_at, 'clicked' FROM scoped WHERE clicked_at IS NOT NULL
    UNION ALL SELECT converted_at, 'converted' FROM scoped WHERE converted_at IS NOT NULL
    UNION ALL SELECT failed_at, 'failed' FROM scoped WHERE failed_at IS NOT NULL
    UNION ALL SELECT sent_at, status FROM scoped WHERE status IN ('skipped', 'uncertain')
  )
  SELECT to_char((at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS day,
    count(*) FILTER (WHERE kind = 'sent')::int AS sent,
    count(*) FILTER (WHERE kind = 'delivered')::int AS delivered,
    count(*) FILTER (WHERE kind = 'read')::int AS read,
    count(*) FILTER (WHERE kind = 'clicked')::int AS clicked,
    count(*) FILTER (WHERE kind = 'converted')::int AS converted,
    count(*) FILTER (WHERE kind = 'failed')::int AS failed,
    count(*) FILTER (WHERE kind = 'skipped')::int AS skipped,
    count(*) FILTER (WHERE kind = 'uncertain')::int AS uncertain
  FROM events GROUP BY 1 ORDER BY 1 DESC LIMIT ${MAX_REPORT_DAYS}`;

const totalsSql = (owner: Owner) => `
  SELECT status, count(*)::int AS n, ${FUNNEL_COLUMNS}
  FROM marketing.message_tracking WHERE project_id = $1 AND ${owner} = $2::uuid
  GROUP BY status`;

const STEPS_SQL = `
  SELECT step_index, max(channel) AS channel, status, count(*)::int AS n, ${FUNNEL_COLUMNS}
  FROM marketing.message_tracking
  WHERE project_id = $1 AND rule_id = $2::uuid AND step_index IS NOT NULL
  GROUP BY step_index, status`;

const VARIANTS_SQL = `
  SELECT step_index, variant_key, sum(sent)::int AS sent, sum(skipped)::int AS skipped, sum(failed)::int AS failed
  FROM marketing.journey_variant_counts WHERE project_id = $1 AND rule_id = $2::uuid
  GROUP BY step_index, variant_key ORDER BY step_index, variant_key`;

const zeroStatuses = (): StatusCounts => ({
  skipped: 0,
  uncertain: 0,
  sent: 0,
  failed: 0,
  delivered: 0,
  read: 0,
  clicked: 0,
  converted: 0,
});
const zeroFunnel = (): Funnel => ({
  sent: 0,
  delivered: 0,
  read: 0,
  clicked: 0,
  converted: 0,
});

interface TotalsRow extends Funnel {
  status: MessageStatus;
  n: number;
}

interface Totals {
  statuses: StatusCounts;
  funnel: Funnel;
}

function addTotals(into: Totals, row: TotalsRow) {
  into.statuses[row.status] += row.n;
  into.funnel.sent += row.sent;
  into.funnel.delivered += row.delivered;
  into.funnel.read += row.read;
  into.funnel.clicked += row.clicked;
  into.funnel.converted += row.converted;
}

function summarize(rows: TotalsRow[]): Totals {
  const total = { statuses: zeroStatuses(), funnel: zeroFunnel() };
  for (const row of rows) {
    addTotals(total, row);
  }
  return total;
}

async function dailyRows(
  sql: Queryable,
  owner: Owner,
  projectId: string,
  id: string,
  timeZone: string
): Promise<DailyRow[]> {
  const rows = await sql.$queryRawUnsafe<DailyRow[]>(
    dailySql(owner),
    projectId,
    id,
    timeZone
  );
  return rows.reverse();
}

async function conversionOf(
  sql: Queryable,
  projectId: string
): Promise<Conversion> {
  const settings = await getTrackingSettings(sql, projectId);
  return {
    event: settings.conversionEvent,
    windowDays: settings.conversionWindowDays,
  };
}

function isChannel(value: string | null): value is CampaignChannel {
  return value !== null && Object.hasOwn(NOT_REPORTED, value);
}

export async function campaignReport(
  sql: Queryable,
  projectId: string,
  campaignId: string,
  timeZone: string
): Promise<CampaignReport | null> {
  const [campaign] = await sql.$queryRawUnsafe<{ channel: CampaignChannel }[]>(
    'SELECT channel FROM marketing.campaigns WHERE id = $1::uuid AND project_id = $2',
    campaignId,
    projectId
  );
  if (!campaign) {
    return null;
  }
  const [totals, daily, conversion] = await Promise.all([
    sql.$queryRawUnsafe<TotalsRow[]>(
      totalsSql('campaign_id'),
      projectId,
      campaignId
    ),
    dailyRows(sql, 'campaign_id', projectId, campaignId, timeZone),
    conversionOf(sql, projectId),
  ]);
  return {
    campaignId,
    channel: campaign.channel,
    ...summarize(totals),
    daily,
    notReported: NOT_REPORTED[campaign.channel],
    conversion,
  };
}

type StepRow = TotalsRow & { step_index: number; channel: string | null };

interface VariantRow {
  step_index: number;
  variant_key: string;
  sent: number;
  skipped: number;
  failed: number;
}

function stepsOf(rows: StepRow[]) {
  const byStep = new Map<number, Totals & { channel: string | null }>();
  for (const row of rows) {
    const step = byStep.get(row.step_index) ?? {
      channel: row.channel,
      statuses: zeroStatuses(),
      funnel: zeroFunnel(),
    };
    addTotals(step, row);
    byStep.set(row.step_index, step);
  }
  return [...byStep]
    .sort(([a], [b]) => a - b)
    .map(([stepIndex, step]) => ({
      stepIndex,
      ...step,
      notReported: isChannel(step.channel) ? NOT_REPORTED[step.channel] : [],
    }));
}

export async function journeyReport(
  sql: Queryable,
  projectId: string,
  ruleId: string,
  timeZone: string
): Promise<JourneyReport | null> {
  const [rule] = await sql.$queryRawUnsafe<{ id: string }[]>(
    'SELECT id FROM marketing.rules WHERE id = $1::uuid AND project_id = $2',
    ruleId,
    projectId
  );
  if (!rule) {
    return null;
  }
  const [stepRows, daily, variants, conversion] = await Promise.all([
    sql.$queryRawUnsafe<StepRow[]>(STEPS_SQL, projectId, ruleId),
    dailyRows(sql, 'rule_id', projectId, ruleId, timeZone),
    sql.$queryRawUnsafe<VariantRow[]>(VARIANTS_SQL, projectId, ruleId),
    conversionOf(sql, projectId),
  ]);
  return {
    ruleId,
    ...summarize(stepRows),
    daily,
    steps: stepsOf(stepRows),
    variants: variants.map((row) => ({
      stepIndex: row.step_index,
      variantKey: row.variant_key,
      sent: row.sent,
      skipped: row.skipped,
      failed: row.failed,
    })),
    conversion,
  };
}
