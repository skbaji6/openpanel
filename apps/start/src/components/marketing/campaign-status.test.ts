import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_STATES,
  type CampaignCounters,
  type CampaignRow,
} from './campaign-contract';
import {
  actionsFor,
  outcomeLine,
  progressOf,
  shouldPoll,
  waitingLine,
} from './campaign-status';

const NONE: CampaignCounters = {
  queued: 0,
  sent: 0,
  failed: 0,
  skipped: 0,
  uncertain: 0,
};
const UNCERTAIN: CampaignCounters = { ...NONE, uncertain: 2 };

const row = (patch: Partial<CampaignRow>): CampaignRow =>
  ({
    state: 'running',
    stateReason: null,
    timezone: 'Asia/Kolkata',
    ifLateMinutes: 30,
    materializeState: 'done',
    dispatchError: null,
    dispatchRetryAt: null,
    ...patch,
  }) as CampaignRow;

describe('actionsFor', () => {
  it('admin sees the transitions the server allows', () => {
    expect(actionsFor('draft', true, NONE)).toEqual(['edit', 'delete']);
    expect(actionsFor('scheduled', true, NONE)).toEqual([
      'unschedule',
      'cancel',
    ]);
    expect(actionsFor('running', true, NONE)).toEqual(['pause', 'cancel']);
    expect(actionsFor('running', true, UNCERTAIN)).toEqual([
      'pause',
      'cancel',
      'retryUncertain',
    ]);
    expect(actionsFor('paused', true, NONE)).toEqual(['resume', 'cancel']);
    expect(actionsFor('paused', true, UNCERTAIN)).toEqual([
      'resume',
      'cancel',
      'retryUncertain',
    ]);
    expect(actionsFor('completed', true, NONE)).toEqual([]);
    expect(actionsFor('completed', true, UNCERTAIN)).toEqual([
      'retryUncertain',
    ]);
  });

  it('finished campaigns that did not complete allow nothing', () => {
    for (const state of ['cancelled', 'failed', 'missed'] as const) {
      expect(actionsFor(state, true, UNCERTAIN)).toEqual([]);
    }
  });

  it('members may only edit a draft', () => {
    for (const state of CAMPAIGN_STATES) {
      const expected = state === 'draft' ? ['edit'] : [];
      expect(actionsFor(state, false, UNCERTAIN)).toEqual(expected);
    }
  });
});

describe('progressOf', () => {
  it('is zero percent with nothing queued', () => {
    expect(progressOf(NONE)).toEqual({ total: 0, done: 0, percent: 0 });
  });

  it('counts every settled recipient as done', () => {
    expect(
      progressOf({ queued: 10, sent: 3, failed: 1, skipped: 1, uncertain: 0 })
    ).toEqual({ total: 10, done: 5, percent: 50 });
  });

  it('never goes above 100', () => {
    expect(
      progressOf({ queued: 2, sent: 3, failed: 0, skipped: 0, uncertain: 0 })
        .percent
    ).toBe(100);
  });
});

describe('waitingLine', () => {
  const retryAt = '2026-11-14T16:30:00.000Z';

  it('names the reason and the local time in the campaign zone', () => {
    expect(
      waitingLine(
        row({ dispatchError: 'quiet_hours', dispatchRetryAt: retryAt }),
        0
      )
    ).toBe('Waiting: quiet hours are on, until 22:00');
  });

  it('says it is pacing when there is a retry time but no error', () => {
    expect(waitingLine(row({ dispatchRetryAt: retryAt }), 0)).toBe(
      "Pacing to the channel's rate"
    );
  });

  it('says the list is being built', () => {
    expect(waitingLine(row({ materializeState: 'in_progress' }), 0)).toBe(
      'Building the recipient list'
    );
  });

  it('is empty when nothing is holding the campaign', () => {
    expect(waitingLine(row({}), 0)).toBeNull();
    expect(
      waitingLine(row({ state: 'completed', dispatchError: 'quiet_hours' }), 0)
    ).toBeNull();
  });
});

describe('outcomeLine', () => {
  it('explains a missed campaign', () => {
    expect(outcomeLine(row({ state: 'missed' }))).toBe(
      'Not sent: the system was not running within 30 minutes of the planned time'
    );
  });

  it('labels the reason of a failed or cancelled campaign', () => {
    expect(
      outcomeLine(row({ state: 'failed', stateReason: 'materialize_failed' }))
    ).toBe('The audience could not be prepared');
    expect(outcomeLine(row({ state: 'cancelled' }))).toBeNull();
  });

  it('is empty for other states', () => {
    expect(outcomeLine(row({ state: 'running' }))).toBeNull();
  });
});

describe('shouldPoll', () => {
  it('polls while the campaign can still change by itself', () => {
    expect(shouldPoll(row({ state: 'scheduled' }))).toBe(true);
    expect(shouldPoll(row({ state: 'running' }))).toBe(true);
    expect(shouldPoll(row({ state: 'paused' }))).toBe(true);
  });

  it('stops once it is finished', () => {
    for (const state of [
      'draft',
      'completed',
      'cancelled',
      'failed',
      'missed',
    ] as const) {
      expect(shouldPoll(row({ state }))).toBe(false);
    }
  });
});
