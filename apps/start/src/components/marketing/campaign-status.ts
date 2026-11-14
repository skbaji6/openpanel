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

export function progressOf(counters: CampaignCounters): {
  total: number;
  done: number;
  percent: number;
} {
  const total = counters.queued;
  const done = counters.sent + counters.failed + counters.skipped;
  const percent =
    total > 0 ? Math.min(PERCENT, Math.round((done / total) * PERCENT)) : 0;
  return { total, done, percent };
}

export function formatClock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(new Date(iso));
}

export function waitingLine(row: CampaignRow, now: number): string | null {
  if (row.state === 'running') {
    const retryAt = row.dispatchRetryAt;
    const inFuture = retryAt !== null && new Date(retryAt).getTime() > now;
    if (row.dispatchError) {
      const label = labelDispatchError(row.dispatchError);
      return retryAt && inFuture
        ? `${label}, until ${formatClock(retryAt, row.timezone)}`
        : label;
    }
    if (retryAt) {
      return "Pacing to the channel's rate";
    }
  }
  const building =
    BUILDING_STATES.includes(row.state) &&
    row.materializeState === 'in_progress';
  return building ? 'Building the recipient list' : null;
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
