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
    expect(progressOf(NONE, 'running')).toEqual({
      total: 0,
      done: 0,
      percent: 0,
    });
  });

  it('counts every final outcome as done, uncertain included', () => {
    expect(
      progressOf(
        { queued: 10, sent: 3, failed: 1, skipped: 1, uncertain: 1 },
        'running'
      )
    ).toEqual({ total: 10, done: 6, percent: 60 });
  });

  it('adds recipients skipped before sending to the total', () => {
    const counters = {
      queued: 1000,
      sent: 700,
      failed: 0,
      skipped: 300,
      uncertain: 0,
    };
    expect(progressOf(counters, 'running', 300)).toEqual({
      total: 1300,
      done: 1000,
      percent: 77,
    });
  });

  it('never goes above 100', () => {
    expect(
      progressOf(
        { queued: 2, sent: 3, failed: 0, skipped: 0, uncertain: 0 },
        'running'
      ).percent
    ).toBe(100);
  });

  it('reads 100 for a completed campaign, even with nothing to send', () => {
    expect(progressOf(NONE, 'completed').percent).toBe(100);
  });
});

describe('waitingLine', () => {
  const retryAt = '2026-11-14T16:30:00.000Z';
  const before = Date.parse('2026-11-14T10:00:00.000Z');
  const after = Date.parse('2026-11-14T17:00:00.000Z');
  const nextDay = Date.parse('2026-11-13T10:00:00.000Z');

  it('names the reason and the time in the viewer zone', () => {
    expect(
      waitingLine(
        row({ dispatchError: 'quiet_hours', dispatchRetryAt: retryAt }),
        before,
        'UTC'
      )
    ).toBe('Waiting: quiet hours are on, until 16:30 UTC');
  });

  it('adds the date when the time is not today', () => {
    expect(
      waitingLine(
        row({ dispatchError: 'quiet_hours', dispatchRetryAt: retryAt }),
        nextDay,
        'UTC'
      )
    ).toBe('Waiting: quiet hours are on, until 14 Nov, 16:30 UTC');
  });

  it('drops the time once it has passed', () => {
    expect(
      waitingLine(
        row({ dispatchError: 'quiet_hours', dispatchRetryAt: retryAt }),
        after,
        'UTC'
      )
    ).toBe('Waiting: quiet hours are on');
  });

  it('labels every dispatch error the server can set', () => {
    for (const code of [
      'source_unavailable',
      'source_auth_failed',
      'source_error',
      'channel_auth_failed',
      'channel_unreachable',
      'channel_not_configured',
      'quota_exhausted',
      'quiet_hours',
      'rate_limited',
      'dispatch_error',
    ]) {
      expect(waitingLine(row({ dispatchError: code }), 0, 'UTC')).toMatch(
        /^Waiting: /
      );
    }
  });

  it('says the list is being built, with the error if the source is down', () => {
    for (const materializeState of ['not_started', 'in_progress'] as const) {
      expect(waitingLine(row({ materializeState }), 0)).toBe(
        'Building the recipient list'
      );
    }
    expect(
      waitingLine(
        row({
          materializeState: 'in_progress',
          materializeError: 'source_unavailable',
        }),
        0
      )
    ).toBe(
      'Building the recipient list. Waiting: the audience API is not answering'
    );
  });

  it('is empty when nothing is holding the campaign', () => {
    expect(waitingLine(row({}), 0)).toBeNull();
    expect(
      waitingLine(row({ state: 'completed', dispatchError: 'quiet_hours' }), 0)
    ).toBeNull();
    expect(
      waitingLine(
        row({ state: 'scheduled', materializeState: 'not_started' }),
        0
      )
    ).toBeNull();
    expect(
      waitingLine(row({ state: 'paused', dispatchError: 'quiet_hours' }), 0)
    ).toBeNull();
  });
});

describe('queued start', () => {
  it('explains a start that waits for the other campaign', () => {
    expect(waitingLine(row({ state: 'scheduled', sendKind: 'now' }), 0)).toBe(
      'Waiting for the other campaign in this project to finish. The count is not checked again when it starts.'
    );
  });

  it('says nothing for a campaign scheduled for later', () => {
    expect(
      waitingLine(row({ state: 'scheduled', sendKind: 'scheduled' }), 0)
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
