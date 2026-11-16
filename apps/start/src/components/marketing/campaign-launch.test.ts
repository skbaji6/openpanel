import { describe, expect, test } from 'vitest';
import { MarketingApiError } from './api';
import type {
  CampaignRow,
  CountPreview,
  Estimate,
  TestSendRow,
} from './campaign-contract';
import {
  confirmFromError,
  formatCost,
  formatDuration,
  labelEstimateIssue,
  launchAction,
  launchSteps,
  PREVIEW_TTL_MS,
  previewIsFresh,
  startConfirmation,
  startHint,
  testSendIdProblem,
  testSendIsPending,
} from './campaign-launch';

const NOW = Date.parse('2026-11-15T10:00:00.000Z');
const AUDIENCE_VERSION = 4;

function preview(overrides: Partial<CountPreview> = {}): CountPreview {
  return {
    count: 1200,
    approximate: false,
    countedAt: new Date(NOW - 60_000).toISOString(),
    filterCount: 1300,
    includeCount: 0,
    excludeCount: 100,
    campaignVersion: 3,
    audienceVersion: AUDIENCE_VERSION,
    ...overrides,
  };
}

function campaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: 'c1',
    projectId: 'p1',
    name: 'Exam reminder',
    state: 'draft',
    stateReason: null,
    channel: 'email',
    template: { body: 'Hi' },
    audienceId: 'a1',
    audienceVersion: null,
    campaignKey: null,
    skipPreviousRecipients: false,
    sendKind: null,
    sendAt: null,
    sendAtLocal: null,
    timezone: 'Asia/Kolkata',
    ifLateMinutes: 60,
    quietHoursOverride: null,
    frequencyCap: null,
    confirmThreshold: 100,
    countPreview: preview(),
    materializeState: 'not_started',
    materializePhase: null,
    materializeError: null,
    materializeAttempts: 0,
    templateVersion: null,
    dispatchError: null,
    dispatchRetryAt: null,
    version: 3,
    createdBy: 'u1',
    createdAt: '2026-11-15T09:00:00.000Z',
    updatedAt: '2026-11-15T09:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    counters: { queued: 0, sent: 0, failed: 0, skipped: 0, uncertain: 0 },
    ...overrides,
  };
}

function testSend(status: TestSendRow['status']): TestSendRow {
  return {
    id: `t-${status}`,
    profileId: 'stu_1',
    status,
    reason: null,
    createdAt: '2026-11-15T09:59:00.000Z',
    sentAt: null,
  };
}

const ESTIMATE: Estimate = {
  count: 1200,
  channel: 'email',
  ratePerSecond: 10,
  estimatedSeconds: 120,
  cost: null,
  quota: null,
  issues: [],
};

const apiError = (code: string, details: Record<string, unknown> | null) =>
  new MarketingApiError(409, code, [], details);

describe('previewIsFresh', () => {
  test('a recent preview of this version and audience version is fresh', () => {
    expect(previewIsFresh(campaign(), NOW, AUDIENCE_VERSION)).toBe(true);
  });

  test('stale once older than the TTL', () => {
    const old = campaign({
      countPreview: preview({
        countedAt: new Date(NOW - PREVIEW_TTL_MS - 1).toISOString(),
      }),
    });
    expect(previewIsFresh(old, NOW, AUDIENCE_VERSION)).toBe(false);
  });

  test('stale when the campaign was edited after counting', () => {
    expect(
      previewIsFresh(campaign({ version: 4 }), NOW, AUDIENCE_VERSION)
    ).toBe(false);
  });

  test('stale when the audience changed after counting', () => {
    expect(previewIsFresh(campaign(), NOW, AUDIENCE_VERSION + 1)).toBe(false);
  });

  test('not fresh without a preview or a known audience version', () => {
    expect(
      previewIsFresh(campaign({ countPreview: null }), NOW, AUDIENCE_VERSION)
    ).toBe(false);
    expect(previewIsFresh(campaign(), NOW, null)).toBe(false);
  });

  test('defaults to the pinned audience version of the row', () => {
    expect(
      previewIsFresh(campaign({ audienceVersion: AUDIENCE_VERSION }), NOW)
    ).toBe(true);
  });
});

describe('confirmFromError', () => {
  test('quota_spread_required after a confirm keeps its count and channel', () => {
    expect(
      confirmFromError(
        apiError('quota_spread_required', {
          count: 1200,
          remainingToday: 300,
          daysNeeded: 3,
        }),
        { count: 1200, channel: 'email' }
      )
    ).toEqual({
      kind: 'spread',
      count: 1200,
      remainingToday: 300,
      daysNeeded: 3,
      channel: 'email',
    });
  });

  test('quota_spread_required without a confirm uses the server count and email', () => {
    expect(
      confirmFromError(
        apiError('quota_spread_required', {
          count: 50,
          remainingToday: 20,
          daysNeeded: 2,
        }),
        undefined
      )
    ).toEqual({
      kind: 'spread',
      count: 50,
      remainingToday: 20,
      daysNeeded: 2,
      channel: 'email',
    });
  });

  test('mismatch and a missing preview ask for a recount', () => {
    const sent = { count: 1, channel: 'email' } as const;
    expect(
      confirmFromError(apiError('confirmation_mismatch', null), sent)
    ).toEqual({ kind: 'recount' });
    expect(
      confirmFromError(apiError('count_preview_required', null), undefined)
    ).toEqual({ kind: 'recount' });
  });

  test('other codes are not handled here', () => {
    expect(
      confirmFromError(apiError('another_campaign_active', null), undefined)
    ).toBeNull();
  });
});

describe('launchSteps', () => {
  const byKey = (steps: ReturnType<typeof launchSteps>) =>
    Object.fromEntries(steps.map((step) => [step.key, step.done]));

  test('all steps in order, done when counted, ready and tested', () => {
    const steps = launchSteps(campaign(), ESTIMATE, NOW, {
      audienceVersion: AUDIENCE_VERSION,
      testSends: [testSend('sent')],
    });
    expect(steps.map((step) => step.key)).toEqual([
      'saved',
      'audience',
      'count',
      'channel',
      'test',
    ]);
    expect(steps.every((step) => step.done)).toBe(true);
    expect(steps.every((step) => step.note.length > 0)).toBe(true);
  });

  test('a stale count, channel issues and no test are not done', () => {
    const steps = launchSteps(
      campaign({ version: 9 }),
      { ...ESTIMATE, issues: ['rate_required'] },
      NOW,
      { audienceVersion: AUDIENCE_VERSION, testSends: [testSend('failed')] }
    );
    expect(byKey(steps)).toEqual({
      saved: true,
      audience: true,
      count: false,
      channel: false,
      test: false,
    });
  });

  test('without an audience or an estimate', () => {
    const steps = launchSteps(
      campaign({ audienceId: null, countPreview: null }),
      null,
      NOW
    );
    expect(byKey(steps)).toMatchObject({
      audience: false,
      count: false,
      channel: false,
    });
  });
});

describe('formatting', () => {
  test('formatDuration', () => {
    expect(formatDuration(3725)).toBe('1 h 2 min');
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(120)).toBe('2 min');
    expect(formatDuration(7200)).toBe('2 h');
  });

  test('formatCost', () => {
    expect(formatCost({ amount: 12.5, currency: 'USD' })).toBe('$12.50');
  });

  test('labelEstimateIssue covers settings and readiness codes', () => {
    expect(labelEstimateIssue('rate_required')).toBe(
      'Set a messages-per-second limit'
    );
    expect(labelEstimateIssue('template_disabled')).not.toBe(
      'template_disabled'
    );
    expect(labelEstimateIssue('something_new')).toBe('something_new');
  });
});

describe('test sends', () => {
  test('testSendIsPending while any row is pending or sending', () => {
    expect(testSendIsPending([testSend('sent'), testSend('pending')])).toBe(
      true
    );
    expect(testSendIsPending([testSend('sending')])).toBe(true);
    expect(testSendIsPending([testSend('sent'), testSend('failed')])).toBe(
      false
    );
    expect(testSendIsPending([])).toBe(false);
  });

  test('testSendIdProblem refuses contacts, blanks and long input', () => {
    expect(testSendIdProblem('stu_123')).toBeNull();
    expect(testSendIdProblem('  ')).not.toBeNull();
    expect(testSendIdProblem('ada@example.com')).not.toBeNull();
    expect(testSendIdProblem('+919800000000')).not.toBeNull();
    expect(testSendIdProblem('x'.repeat(257))).not.toBeNull();
  });
});

describe('launchAction', () => {
  test('start now without a send time', () => {
    expect(launchAction(campaign())).toEqual({
      path: 'start',
      label: 'Start now',
      title: 'Start',
    });
  });

  test('schedule with the local time and zone as typed', () => {
    expect(launchAction(campaign({ sendAtLocal: '2026-11-20T09:30' }))).toEqual(
      {
        path: 'schedule',
        label: 'Schedule for 2026-11-20 09:30 (Asia/Kolkata)',
        title: 'Schedule',
      }
    );
  });
});

describe('confirmFromError malformed spread', () => {
  test('quota_spread_required with malformed details is not handled', () => {
    expect(
      confirmFromError(
        apiError('quota_spread_required', {
          count: 50,
          remainingToday: 'some',
          daysNeeded: 2,
        }),
        { count: 50, channel: 'email' }
      )
    ).toBeNull();
    expect(
      confirmFromError(apiError('quota_spread_required', null), undefined)
    ).toBeNull();
  });
});

describe('startConfirmation', () => {
  test('below the threshold it still confirms the count shown', () => {
    const row = campaign({
      confirmThreshold: 100,
      countPreview: preview({ count: 50 }),
    });
    const result = startConfirmation(row, true);
    expect(result?.confirm).toEqual({ count: 50, channel: 'email' });
    expect(result?.title).toBe('Send to 50 students by Email?');
    expect(result?.text).toContain('50');
  });

  test('no start without a fresh shown count', () => {
    expect(startConfirmation(campaign(), false)).toBeNull();
    expect(
      startConfirmation(campaign({ countPreview: null }), true)
    ).toBeNull();
  });

  test('a schedule names the time in the title', () => {
    const row = campaign({
      channel: 'sms',
      sendAtLocal: '2026-11-20T09:30',
      countPreview: preview({ count: 7 }),
    });
    expect(startConfirmation(row, true)).toMatchObject({
      title:
        'Schedule for 2026-11-20 09:30 (Asia/Kolkata) to 7 students by SMS?',
      confirm: { count: 7, channel: 'sms' },
    });
  });
});

describe('start guards', () => {
  test('no confirmation or start for an empty audience', () => {
    const row = campaign({ countPreview: preview({ count: 0 }) });
    expect(startConfirmation(row, true)).toBeNull();
    expect(startHint(row, true)).toContain('no students');
  });

  test('hint depends on whether a count exists and is fresh', () => {
    expect(startHint(campaign({ countPreview: null }), false)).toBe(
      'Count the audience first'
    );
    expect(startHint(campaign({ countPreview: preview() }), false)).toBe(
      'Count again first'
    );
    expect(startHint(campaign({ countPreview: preview() }), true)).toBeNull();
  });

  test('the confirm names a registry template and its version', () => {
    const row = campaign({
      channel: 'sms',
      template: { templateId: 'exam_reminder' },
      templateVersion: 3,
      countPreview: preview({ count: 5 }),
    });
    expect(startConfirmation(row, true)?.text).toContain(
      'using template exam_reminder, version 3'
    );
  });
});
