export const CAMPAIGN_STATES = [
  'draft',
  'scheduled',
  'running',
  'paused',
  'completed',
  'cancelled',
  'failed',
  'missed',
] as const;

export type CampaignState = (typeof CAMPAIGN_STATES)[number];

export type CampaignAction =
  | 'schedule'
  | 'unschedule'
  | 'start'
  | 'claim_due'
  | 'miss'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'complete'
  | 'fail';

export const TERMINAL_STATES = [
  'completed',
  'cancelled',
  'failed',
  'missed',
] as const satisfies readonly CampaignState[];

const TRANSITIONS: Partial<
  Record<CampaignState, Partial<Record<CampaignAction, CampaignState>>>
> = {
  draft: { schedule: 'scheduled', start: 'running' },
  scheduled: {
    unschedule: 'draft',
    start: 'running',
    claim_due: 'running',
    miss: 'missed',
    cancel: 'cancelled',
  },
  running: {
    pause: 'paused',
    cancel: 'cancelled',
    complete: 'completed',
    fail: 'failed',
  },
  paused: { resume: 'running', cancel: 'cancelled', fail: 'failed' },
};

export function nextState(
  state: CampaignState,
  action: CampaignAction
): CampaignState | null {
  return TRANSITIONS[state]?.[action] ?? null;
}

// For fenced updates: `UPDATE ... WHERE state = ANY($n)`.
export function fromStates(action: CampaignAction): CampaignState[] {
  return CAMPAIGN_STATES.filter((state) => nextState(state, action));
}
