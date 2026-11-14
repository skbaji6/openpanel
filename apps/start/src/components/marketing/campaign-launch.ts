import type { MarketingApiError } from './api';
import { looksLikeContacts } from './audience-paste';
import {
  CAMPAIGN_CHANNELS,
  type CampaignChannel,
  type CampaignRow,
  type Confirmation,
  type Estimate,
  MAX_ID_LENGTH,
  type TestSendRow,
} from './campaign-contract';
import { ERROR_LABELS } from './error-labels';
import { labelSettingsIssue } from './reason-labels';

// The server accepts a count preview for 15 minutes.
export const PREVIEW_TTL_MS = 900_000;

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const RECOUNT_CODES = new Set([
  'confirmation_mismatch',
  'count_preview_required',
]);
// The daily quota only exists for email, so a spread request without a confirm is always email.
const QUOTA_CHANNEL: CampaignChannel = 'email';
const ID_PROBLEM_EMPTY = 'Enter a student id.';
const ID_PROBLEM_CONTACT =
  "Enter the student's id, not a phone number or email address.";
const ID_PROBLEM_LONG = `A student id is at most ${MAX_ID_LENGTH} characters.`;

export type LaunchDecision =
  | { kind: 'confirm'; count: number; channel: CampaignChannel }
  | {
      kind: 'spread';
      count: number;
      remainingToday: number;
      daysNeeded: number;
      channel: CampaignChannel;
    }
  | { kind: 'recount' };

export type LaunchStepKey = 'saved' | 'audience' | 'count' | 'channel' | 'test';

export interface LaunchStep {
  key: LaunchStepKey;
  done: boolean;
  note: string;
}

const isChannel = (value: unknown): value is CampaignChannel =>
  CAMPAIGN_CHANNELS.some((channel) => channel === value);

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

// Campaign drafts carry no pinned audience version, so the caller passes the audience's current one.
export function previewIsFresh(
  row: CampaignRow,
  now: number,
  audienceVersion: number | null = row.audienceVersion
): boolean {
  const preview = row.countPreview;
  if (!preview || audienceVersion === null) {
    return false;
  }
  const sameVersions =
    preview.campaignVersion === row.version &&
    preview.audienceVersion === audienceVersion;
  return sameVersions && now - Date.parse(preview.countedAt) <= PREVIEW_TTL_MS;
}

export function confirmFromError(
  error: MarketingApiError,
  sent: Confirmation | undefined
): LaunchDecision | null {
  if (RECOUNT_CODES.has(error.code)) {
    return { kind: 'recount' };
  }
  const details = error.details ?? {};
  if (error.code === 'confirmation_required') {
    const { count, channel } = details;
    if (!(isCount(count) && isChannel(channel))) {
      return null;
    }
    return { kind: 'confirm', count, channel };
  }
  if (error.code === 'quota_spread_required') {
    const { count, remainingToday, daysNeeded } = details;
    if (!(isCount(count) && isCount(remainingToday) && isCount(daysNeeded))) {
      return null;
    }
    return {
      kind: 'spread',
      count: sent?.count ?? count,
      remainingToday,
      daysNeeded,
      channel: sent?.channel ?? QUOTA_CHANNEL,
    };
  }
  return null;
}

function countNote(row: CampaignRow, fresh: boolean): string {
  if (!row.countPreview) {
    return 'Not counted yet';
  }
  if (!fresh) {
    return 'The count is out of date: count again';
  }
  return `${row.countPreview.count} students`;
}

function channelNote(estimate: Estimate | null): string {
  if (!estimate) {
    return 'Checked after the count';
  }
  if (estimate.issues.length > 0) {
    return 'The channel needs attention';
  }
  return 'Channel ready';
}

export function launchSteps(
  row: CampaignRow,
  estimate: Estimate | null,
  now: number,
  context: {
    audienceVersion?: number | null;
    testSends?: TestSendRow[];
  } = {}
): LaunchStep[] {
  const fresh = previewIsFresh(
    row,
    now,
    context.audienceVersion === undefined
      ? row.audienceVersion
      : context.audienceVersion
  );
  const tested = (context.testSends ?? []).some(
    (testSend) => testSend.status === 'sent'
  );
  const hasAudience = row.audienceId !== null;
  const channelReady = estimate !== null && estimate.issues.length === 0;
  return [
    { key: 'saved', done: true, note: 'Draft saved' },
    {
      key: 'audience',
      done: hasAudience,
      note: hasAudience ? 'Audience chosen' : 'Choose an audience',
    },
    { key: 'count', done: fresh, note: countNote(row, fresh) },
    { key: 'channel', done: channelReady, note: channelNote(estimate) },
    {
      key: 'test',
      done: tested,
      note: tested ? 'A test was sent' : 'Optional: send yourself a test',
    },
  ];
}

export function formatDuration(seconds: number): string {
  if (seconds < SECONDS_PER_MINUTE) {
    return `${Math.ceil(seconds)} s`;
  }
  const totalMinutes = Math.round(seconds / SECONDS_PER_MINUTE);
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  if (hours === 0) {
    return `${minutes} min`;
  }
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

export function formatCost(cost: { amount: number; currency: string }): string {
  return new Intl.NumberFormat('en', {
    style: 'currency',
    currency: cost.currency,
  }).format(cost.amount);
}

export const labelEstimateIssue = (code: string): string => {
  const settingsLabel = labelSettingsIssue(code);
  return settingsLabel === code ? (ERROR_LABELS[code] ?? code) : settingsLabel;
};

export const testSendIsPending = (rows: TestSendRow[]): boolean =>
  rows.some((row) => row.status === 'pending' || row.status === 'sending');

export function testSendIdProblem(input: string): string | null {
  const id = input.trim();
  if (id === '') {
    return ID_PROBLEM_EMPTY;
  }
  if (looksLikeContacts(id) || id.startsWith('+')) {
    return ID_PROBLEM_CONTACT;
  }
  return id.length > MAX_ID_LENGTH ? ID_PROBLEM_LONG : null;
}

// sendAtLocal is wall-clock time in the campaign's zone, so it is shown as typed.
export function launchAction(row: CampaignRow): {
  path: 'start' | 'schedule';
  label: string;
} {
  if (!row.sendAtLocal) {
    return { path: 'start', label: 'Start now' };
  }
  return {
    path: 'schedule',
    label: `Schedule for ${row.sendAtLocal.replace('T', ' ')} (${row.timezone})`,
  };
}
