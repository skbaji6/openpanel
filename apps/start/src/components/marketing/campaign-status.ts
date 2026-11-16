import type {
  CampaignCounters,
  CampaignRow,
  CampaignState,
} from './campaign-contract';
import { labelDispatchError, labelStateReason } from './reason-labels';

export type CampaignActionName =
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'retryUncertain'
  | 'delete'
  | 'edit'
  | 'unschedule';

const PERCENT = 100;
const POLLED_STATES: readonly CampaignState[] = [
  'scheduled',
  'running',
  'paused',
];
export const QUEUED_START_LINE =
  'Waiting for the other campaign in this project to finish. The count is not checked again when it starts.';
const BUILDING_STATES: readonly CampaignState[] = ['running', 'paused'];

// Mirrors the server's transition table (campaign/state.ts) and RETRYABLE in operator.ts.
export function actionsFor(
  state: CampaignState,
  isAdmin: boolean,
  counters: CampaignCounters
): CampaignActionName[] {
  if (state === 'draft') {
    return isAdmin ? ['edit', 'delete'] : ['edit'];
  }
  if (!isAdmin) {
    return [];
  }
  const retry: CampaignActionName[] =
    counters.uncertain > 0 ? ['retryUncertain'] : [];
  switch (state) {
    case 'scheduled':
      return ['unschedule', 'cancel'];
    case 'running':
      return ['pause', 'cancel', ...retry];
    case 'paused':
      return ['resume', 'cancel', ...retry];
    case 'completed':
      return retry;
    default:
      return [];
  }
}

export const ALREADY_RECEIVED = 'already_received';

// `queued` is fixed after the list is built and leaves out recipients skipped as already received,
// so those are added back to get the real total.
export function progressOf(
  counters: CampaignCounters,
  state: CampaignState,
  preSkipped = 0
): {
  total: number;
  done: number;
  percent: number;
} {
  const total = counters.queued + preSkipped;
  const done =
    counters.sent + counters.failed + counters.uncertain + counters.skipped;
  if (state === 'completed') {
    return { total, done, percent: PERCENT };
  }
  const percent =
    total > 0 ? Math.min(PERCENT, Math.round((done / total) * PERCENT)) : 0;
  return { total, done, percent };
}

export function formatRetryTime(
  iso: string,
  now: number,
  timeZone?: string
): string {
  const target = new Date(iso);
  const part = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-GB', {
      ...options,
      timeZone,
    }).formatToParts(target);
  const clock = part({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .filter(
      (p) => p.type === 'hour' || p.type === 'minute' || p.type === 'literal'
    )
    .map((p) => p.value)
    .join('');
  const zone =
    part({ timeZoneName: 'short' }).find((p) => p.type === 'timeZoneName')
      ?.value ?? '';
  const day = (date: Date | number) =>
    new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      timeZone,
    }).format(date);
  const sameDay = day(target) === day(now);
  const when = sameDay ? clock : `${day(target)}, ${clock}`;
  return `${when} ${zone}`.trim();
}

export function waitingLine(
  row: CampaignRow,
  now: number,
  timeZone?: string
): string | null {
  const building =
    BUILDING_STATES.includes(row.state) &&
    (row.materializeState === 'in_progress' ||
      row.materializeState === 'not_started');
  if (building) {
    return row.materializeError
      ? `Building the recipient list. ${labelDispatchError(row.materializeError)}`
      : 'Building the recipient list';
  }
  if (row.state === 'scheduled' && row.sendKind === 'now') {
    return QUEUED_START_LINE;
  }
  if (row.state !== 'running' || !row.dispatchError) {
    return null;
  }
  const label = labelDispatchError(row.dispatchError);
  const retryAt = row.dispatchRetryAt;
  if (!retryAt || new Date(retryAt).getTime() <= now) {
    return label;
  }
  return `${label}, until ${formatRetryTime(retryAt, now, timeZone)}`;
}

export function outcomeLine(row: CampaignRow): string | null {
  if (row.state === 'missed') {
    return `Not sent: the system was not running within ${row.ifLateMinutes} minutes of the planned time`;
  }
  const labelled = row.state === 'failed' || row.state === 'cancelled';
  return labelled && row.stateReason ? labelStateReason(row.stateReason) : null;
}

export function shouldPoll(row: CampaignRow): boolean {
  return POLLED_STATES.includes(row.state);
}
