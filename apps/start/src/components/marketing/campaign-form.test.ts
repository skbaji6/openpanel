import { describe, expect, test } from 'vitest';
import type { CampaignRow } from './campaign-contract';
import {
  audienceLabel,
  type CampaignForm,
  campaignProblems,
  emptyCampaign,
  fromRow,
  PROBLEM_LABELS,
  progressText,
  pushPreview,
  STATE_BADGE,
  sendTimeText,
  toDraftBody,
  withChannel,
} from './campaign-form';

const AUDIENCE_ID = '7d3f1c2e-9a4b-4c5d-8e6f-1a2b3c4d5e6f';

function form(patch: Partial<CampaignForm> = {}): CampaignForm {
  return { ...emptyCampaign(), name: 'Welcome back', ...patch };
}

function row(patch: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: 'c1',
    projectId: 'p1',
    name: 'Welcome back',
    state: 'draft',
    stateReason: null,
    channel: 'push',
    template: {
      subject: 'Hi {{profile.firstName}}',
      body: 'New course',
      imageUrl: 'https://cdn.example.com/a.png',
      link: 'sia://course/12',
    },
    audienceId: AUDIENCE_ID,
    audienceVersion: null,
    campaignKey: 'nov-promo',
    skipPreviousRecipients: true,
    sendKind: null,
    sendAt: null,
    sendAtLocal: '2026-11-20T09:30',
    timezone: 'Asia/Kolkata',
    ifLateMinutes: 30,
    quietHoursOverride: {
      enabled: true,
      start: '21:00',
      end: '08:00',
      timezone: 'Asia/Kolkata',
    },
    frequencyCap: { max: 2, periodSeconds: 86_400 },
    confirmThreshold: 1000,
    countPreview: null,
    materializeState: 'not_started',
    materializePhase: null,
    materializeError: null,
    materializeAttempts: 0,
    templateVersion: null,
    dispatchError: null,
    dispatchRetryAt: null,
    version: 3,
    createdBy: 'u1',
    createdAt: '2026-11-14T00:00:00Z',
    updatedAt: '2026-11-14T00:00:00Z',
    startedAt: null,
    finishedAt: null,
    counters: { queued: 0, sent: 0, failed: 0, skipped: 0, uncertain: 0 },
    ...patch,
  };
}

const NULL_FIELDS = {
  audienceId: null,
  campaignKey: null,
  skipPreviousRecipients: false,
  sendAtLocal: null,
  timezone: 'Asia/Kolkata',
  ifLateMinutes: 60,
  quietHoursOverride: null,
  frequencyCap: null,
};

describe('toDraftBody', () => {
  test('push omits blank optional strings', () => {
    expect(toDraftBody(form({ body: 'Hello', subject: '  ' }))).toEqual({
      name: 'Welcome back',
      channel: 'push',
      template: { body: 'Hello' },
      ...NULL_FIELDS,
    });
  });

  test('push keeps title, image and link', () => {
    const body = toDraftBody(
      form({
        subject: 'Hi',
        body: 'Text',
        imageUrl: ' https://cdn.example.com/a.png ',
        link: 'sia://course/12',
      })
    ) as { template: unknown };
    expect(body.template).toEqual({
      subject: 'Hi',
      body: 'Text',
      imageUrl: 'https://cdn.example.com/a.png',
      link: 'sia://course/12',
    });
  });

  test('email and webhook send subject and body only', () => {
    const email = toDraftBody(
      form({ channel: 'email', subject: 'S', body: '<p>B</p>', link: 'x' })
    ) as { template: unknown };
    expect(email.template).toEqual({ subject: 'S', body: '<p>B</p>' });
    const webhook = toDraftBody(
      form({ channel: 'webhook', body: '{"a":1}' })
    ) as { template: unknown };
    expect(webhook.template).toEqual({ body: '{"a":1}' });
  });

  test('sms and whatsapp send the template id only', () => {
    for (const channel of ['sms', 'whatsapp'] as const) {
      const body = toDraftBody(
        form({ channel, templateId: 't1', body: 'ignored' })
      ) as { template: unknown };
      expect(body.template).toEqual({ templateId: 't1' });
    }
  });

  test('sending now clears the send time; overrides off are null', () => {
    const body = toDraftBody(
      form({ sendKind: 'now', sendAtLocal: '2026-11-20T09:30', capMax: '3' })
    ) as Record<string, unknown>;
    expect(body.sendAtLocal).toBeNull();
    expect(body.frequencyCap).toBeNull();
    expect(body.quietHoursOverride).toBeNull();
  });

  test('quiet hours off for this campaign', () => {
    const body = toDraftBody(form({ quietHours: 'off' })) as Record<
      string,
      unknown
    >;
    expect(body.quietHoursOverride).toEqual({ enabled: false });
  });
});

describe('fromRow', () => {
  test('round trips the draft fields', () => {
    const source = row();
    expect(toDraftBody(fromRow(source))).toEqual({
      name: source.name,
      channel: source.channel,
      template: source.template,
      audienceId: source.audienceId,
      campaignKey: source.campaignKey,
      skipPreviousRecipients: true,
      sendAtLocal: source.sendAtLocal,
      timezone: source.timezone,
      ifLateMinutes: source.ifLateMinutes,
      quietHoursOverride: source.quietHoursOverride,
      frequencyCap: source.frequencyCap,
    });
  });

  test('round trips a plain sms draft', () => {
    const source = row({
      channel: 'sms',
      template: { templateId: 't9' },
      audienceId: null,
      campaignKey: null,
      skipPreviousRecipients: false,
      sendAtLocal: null,
      quietHoursOverride: null,
      frequencyCap: null,
    });
    const back = fromRow(source);
    expect(back.sendKind).toBe('now');
    expect(toDraftBody(back)).toEqual({
      name: source.name,
      channel: 'sms',
      template: { templateId: 't9' },
      ...NULL_FIELDS,
      ifLateMinutes: source.ifLateMinutes,
    });
  });
});

describe('withChannel', () => {
  test('clears the message', () => {
    const next = withChannel(
      form({ body: 'x', subject: 'y', templateId: 't', imageUrl: 'z' }),
      'email'
    );
    expect(next.channel).toBe('email');
    expect([next.body, next.subject, next.templateId, next.imageUrl]).toEqual([
      '',
      '',
      '',
      '',
    ]);
  });
});

describe('campaignProblems', () => {
  const pathsOf = (value: CampaignForm) =>
    campaignProblems(value).map((problem) => problem.path);

  test('a complete push draft has none', () => {
    expect(campaignProblems(form({ body: 'Hello' }))).toEqual([]);
  });

  test('skipping previous recipients needs a key', () => {
    expect(
      pathsOf(form({ body: 'x', skipPreviousRecipients: true }))
    ).toContain('campaignKey');
  });

  test('scheduled needs a send time', () => {
    expect(pathsOf(form({ body: 'x', sendKind: 'scheduled' }))).toEqual([
      'sendAtLocal',
    ]);
  });

  test('push image must be https', () => {
    expect(
      pathsOf(form({ body: 'x', imageUrl: 'http://cdn.example.com/a.png' }))
    ).toEqual(['template.imageUrl']);
  });

  test('push link rejects unsafe schemes and variables', () => {
    expect(pathsOf(form({ body: 'x', link: 'javascript:alert(1)' }))).toEqual([
      'template.link',
    ]);
    expect(
      pathsOf(form({ body: 'x', link: 'sia://course/{{profile.id}}' }))
    ).toEqual(['template.link']);
  });

  test('custom quiet hours need both times', () => {
    expect(pathsOf(form({ body: 'x', quietHours: 'custom' }))).toContain(
      'quietHoursOverride.start'
    );
  });

  test('an unknown time zone is reported when scheduled', () => {
    expect(
      pathsOf(
        form({
          body: 'x',
          sendKind: 'scheduled',
          sendAtLocal: '2026-11-20T09:30',
          timezone: 'Mars/Base',
        })
      )
    ).toEqual(['timezone']);
  });

  test('sending now ignores the hidden time zone and late minutes', () => {
    const value = form({ body: 'x', timezone: 'Mars/Base', ifLateMinutes: '' });
    expect(campaignProblems(value)).toEqual([]);
    expect(toDraftBody(value)).toMatchObject({
      timezone: 'Asia/Kolkata',
      ifLateMinutes: 60,
    });
    expect(
      toDraftBody(form({ timezone: 'Europe/Berlin', ifLateMinutes: '15' }))
    ).toMatchObject({ timezone: 'Europe/Berlin', ifLateMinutes: 15 });
  });

  test('sms needs a template', () => {
    expect(pathsOf(form({ channel: 'sms' }))).toEqual(['template.templateId']);
  });
});

describe('campaignProblems messages', () => {
  const messageAt = (value: CampaignForm, path: string) =>
    campaignProblems(value).find((problem) => problem.path === path)?.message;
  const scheduled = {
    sendKind: 'scheduled',
    sendAtLocal: '2026-11-20T09:30',
  } as const;

  test('quiet hours times', () => {
    const value = form({ body: 'x', quietHours: 'custom' });
    expect(messageAt(value, 'quietHoursOverride.start')).toBe('Pick a time');
    expect(messageAt(value, 'quietHoursOverride.end')).toBe('Pick a time');
    expect(
      messageAt(
        form({
          body: 'x',
          quietHours: 'custom',
          quietStart: '21:00',
          quietEnd: '21:00',
        }),
        'quietHoursOverride.end'
      )
    ).toBe('Pick an end time different from the start');
  });

  test('no template', () => {
    expect(
      messageAt(form({ channel: 'whatsapp' }), 'template.templateId')
    ).toBe('Pick a template');
  });

  test('blank numbers', () => {
    expect(
      messageAt(
        form({ body: 'x', ...scheduled, ifLateMinutes: '' }),
        'ifLateMinutes'
      )
    ).toBe('Enter a number');
    expect(
      messageAt(
        form({ body: 'x', capEnabled: true, capMax: '' }),
        'frequencyCap.max'
      )
    ).toBe('Enter a number');
    expect(
      messageAt(
        form({ body: 'x', capEnabled: true, capPeriodHours: '' }),
        'frequencyCap.periodSeconds'
      )
    ).toBe('Enter a number');
  });

  test('period under a minute', () => {
    expect(
      messageAt(
        form({ body: 'x', capEnabled: true, capPeriodHours: '0.01' }),
        'frequencyCap.periodSeconds'
      )
    ).toBe('Use at least 1 minute');
  });

  test('message text is required for text channels', () => {
    for (const channel of ['push', 'email', 'webhook'] as const) {
      expect(messageAt(form({ channel }), 'template.body')).toBe(
        'Write the message text'
      );
    }
  });

  test('image and link', () => {
    expect(
      messageAt(
        form({ body: 'x', imageUrl: 'http://x.example/a.png' }),
        'template.imageUrl'
      )
    ).toBe('Use an https link without a user name or password');
    expect(
      messageAt(
        form({ body: 'x', link: 'javascript:alert(1)' }),
        'template.link'
      )
    ).toBe('Use a full link such as https://… or sia://…');
  });

  test('other fields read as sentences, never zod text', () => {
    const value = form({
      name: ' ',
      body: 'x',
      skipPreviousRecipients: true,
      ...scheduled,
      timezone: 'Mars/Base',
    });
    expect(messageAt(value, 'name')).toBe('Give the campaign a name');
    expect(messageAt(value, 'campaignKey')).toBe(
      'Add a campaign key to skip students who already received it'
    );
    expect(messageAt(value, 'timezone')).toBe(
      'Use a time zone such as Asia/Kolkata'
    );
  });

  test('every path has a label', () => {
    expect(PROBLEM_LABELS['frequencyCap.periodSeconds']).toBe('Limit period');
  });
});

describe('toDraftBody details', () => {
  test('cap with fractional hours gives whole seconds', () => {
    expect(
      (
        toDraftBody(
          form({ capEnabled: true, capMax: '3', capPeriodHours: '1.5005' })
        ) as Record<string, unknown>
      ).frequencyCap
    ).toEqual({ max: 3, periodSeconds: 5402 });
  });

  test('custom quiet hours', () => {
    expect(
      (
        toDraftBody(
          form({
            quietHours: 'custom',
            quietStart: '21:00',
            quietEnd: '08:00',
            quietTimezone: 'Asia/Dubai',
          })
        ) as Record<string, unknown>
      ).quietHoursOverride
    ).toEqual({
      enabled: true,
      start: '21:00',
      end: '08:00',
      timezone: 'Asia/Dubai',
    });
  });

  test('sendAtLocal passes through unchanged', () => {
    expect(
      (
        toDraftBody(
          form({ sendKind: 'scheduled', sendAtLocal: '2026-03-29T02:30' })
        ) as Record<string, unknown>
      ).sendAtLocal
    ).toBe('2026-03-29T02:30');
  });

  test('withChannel leaves non-message fields alone', () => {
    const before = form({
      audienceId: AUDIENCE_ID,
      campaignKey: 'k',
      sendKind: 'scheduled',
      sendAtLocal: '2026-11-20T09:30',
      capEnabled: true,
      body: 'x',
    });
    const { subject, body, imageUrl, link, templateId, channel, ...rest } =
      withChannel(before, 'sms');
    const {
      subject: _s,
      body: _b,
      imageUrl: _i,
      link: _l,
      templateId: _t,
      channel: _c,
      ...restBefore
    } = before;
    expect(rest).toEqual(restBefore);
  });
});

describe('pushPreview', () => {
  test('shows title, text and a valid image', () => {
    expect(
      pushPreview(
        form({
          subject: 'Hi',
          body: 'Text',
          imageUrl: 'https://cdn.example.com/a.png',
        })
      )
    ).toEqual({
      title: 'Hi',
      body: 'Text',
      imageUrl: 'https://cdn.example.com/a.png',
    });
  });

  test('hides a blank title and an invalid image', () => {
    expect(
      pushPreview(form({ body: 'Text', imageUrl: 'http://x.example/a.png' }))
    ).toEqual({ title: null, body: 'Text', imageUrl: null });
    expect(
      pushPreview(form({ body: 'Text', imageUrl: 'https://u:p@x.example/a' }))
        .imageUrl
    ).toBeNull();
  });
});

describe('audienceLabel', () => {
  const audiences = [{ id: AUDIENCE_ID, name: 'Grade 10' }];
  test('names, deleted, unknown and none', () => {
    expect(audienceLabel(AUDIENCE_ID, { audiences, failed: false })).toBe(
      'Grade 10'
    );
    expect(audienceLabel('gone', { audiences, failed: false })).toBe(
      'Deleted audience'
    );
    expect(
      audienceLabel(AUDIENCE_ID, { audiences: undefined, failed: true })
    ).toBe('—');
    expect(
      audienceLabel(AUDIENCE_ID, { audiences: undefined, failed: false })
    ).toBe('');
    expect(audienceLabel(null, { audiences, failed: false })).toBe('');
  });
});

describe('list text', () => {
  test('send time is shown in the campaign zone as typed', () => {
    expect(sendTimeText(row())).toBe('2026-11-20 09:30 Asia/Kolkata');
    expect(sendTimeText(row({ sendAtLocal: null }))).toBe('When launched');
  });

  test('progress only once started', () => {
    expect(progressText(row())).toBe('');
    expect(
      progressText(
        row({
          startedAt: '2026-11-14T01:00:00Z',
          counters: {
            queued: 10,
            sent: 4,
            failed: 0,
            skipped: 0,
            uncertain: 0,
          },
        })
      )
    ).toBe('4 / 10');
  });
});

test('every state has a badge', () => {
  expect(STATE_BADGE.draft.label).toBe('Draft');
  expect(STATE_BADGE.running.variant).toBe('info');
});
