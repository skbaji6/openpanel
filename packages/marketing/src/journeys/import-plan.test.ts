import { describe, expect, it } from 'bun:test';
import { zRuleDefinition } from '../rules/rule.schema';
import {
  GOAL_GUESSES,
  type ImportOptions,
  journeyKeyOf,
  planImport,
} from './import-plan';
import type { SheetRows } from './xlsx-reader';

type Row = [event: string, platform: string, timing: string, message: string];

const MESSAGES = ['Secret alpha text', 'Secret beta text', 'Secret gamma text'];
const PLATFORM = 'In-App Notification';
const options: ImportOptions = { states: { TS: 'TS', AP: 'AP' } };

function sheet(
  name: string,
  rows: Row[],
  extra: Record<string, string> = {}
): SheetRows {
  return {
    sheet: name,
    rows: rows.map(([event, platform, timing, message], index) => {
      const cells: Record<string, string> = Object.create(null);
      cells['Event Name'] = event;
      cells.Platform = platform;
      cells.Timing = timing;
      cells['Message (Content)'] = message;
      Object.assign(cells, extra);
      return { rowNumber: index + 2, cells };
    }),
  };
}

const tsRows: Row[] = [
  ['Registration Started', PLATFORM, 'D0 Immediate', MESSAGES[0] ?? ''],
  ['Registration Started', PLATFORM, 'D1', MESSAGES[1] ?? ''],
  ['Invalid PIN / OTP', PLATFORM, 'D0 on exit', MESSAGES[2] ?? ''],
  ['Cart Abandoned', PLATFORM, 'D0 confirmation', 'cart'],
];
const apRows: Row[] = tsRows.map(([e, p, t, m]) => [e, p, t, `${m} ap`]);

describe('journeyKeyOf', () => {
  it('collapses non-alphanumerics', () => {
    expect(journeyKeyOf('Invalid PIN / OTP')).toBe('invalid_pin_otp');
    expect(journeyKeyOf('  --Cart  Abandoned!! ')).toBe('cart_abandoned');
  });
});

describe('planImport', () => {
  it('two state sheets become one journey with two variants per step', () => {
    const { journeys, problems } = planImport(
      [sheet('TS', tsRows), sheet('AP', apRows)],
      options
    );
    expect(problems).toEqual([]);
    expect(journeys.map((j) => j.key).sort()).toEqual([
      'cart_abandoned',
      'invalid_pin_otp',
      'registration_started',
    ]);
    const registration = journeys.find((j) => j.key === 'registration_started');
    expect(registration?.definition.steps.map((s) => s.delaySeconds)).toEqual([
      0, 86_400,
    ]);
    for (const step of registration?.definition.steps ?? []) {
      expect(Object.keys(step.variants ?? {}).sort()).toEqual(['AP', 'TS']);
      expect(step.template).toBeUndefined();
    }
    expect(zRuleDefinition.safeParse(registration?.definition).success).toBe(
      true
    );
    expect(registration?.definition.reentry).toEqual({
      enabled: true,
      cooldownSeconds: 21 * 86_400,
    });
    expect(registration?.definition.steps[0]?.channel).toBe('push');
  });

  it('D0 Immediate, D0 on exit and D0 confirmation are delay 0', () => {
    const { journeys } = planImport(
      [
        sheet('TS', [
          ['A', PLATFORM, 'D0 Immediate', 'x'],
          ['B', PLATFORM, 'd0 on exit', 'x'],
          ['C', PLATFORM, 'D0 confirmation', 'x'],
        ]),
      ],
      options
    );
    expect(
      journeys.map((j) => j.definition.steps.map((s) => s.delaySeconds))
    ).toEqual([[0], [0], [0]]);
  });

  it('D1 on next failed login is reported conditional_timing and not a step', () => {
    const { journeys, problems } = planImport(
      [
        sheet('TS', [
          ['A', PLATFORM, 'D0', 'x'],
          ['A', PLATFORM, 'D1 on next failed login', 'y'],
        ]),
      ],
      options
    );
    expect(problems).toEqual([
      { sheet: 'TS', row: 3, code: 'conditional_timing', column: 'Timing' },
    ]);
    expect(journeys[0]?.definition.steps).toHaveLength(1);
  });

  it('a row with an empty message is reported and the rest of the journey imports', () => {
    const { journeys, problems } = planImport(
      [
        sheet('TS', [
          ['A', PLATFORM, 'D0', '  '],
          ['A', PLATFORM, 'D1', 'x'],
        ]),
      ],
      options
    );
    expect(problems).toEqual([
      {
        sheet: 'TS',
        row: 2,
        code: 'empty_message',
        column: 'Message (Content)',
      },
    ]);
    expect(journeys[0]?.definition.steps.map((s) => s.delaySeconds)).toEqual([
      86_400,
    ]);
  });

  it('an unknown sheet is reported unknown_sheet', () => {
    const { journeys, problems } = planImport(
      [sheet('Other', tsRows)],
      options
    );
    expect(journeys).toEqual([]);
    expect(problems).toEqual([
      { sheet: 'Other', row: null, code: 'unknown_sheet' },
    ]);
  });

  it('csv rows with an empty state are reported per row', () => {
    const { problems } = planImport([sheet('', tsRows.slice(0, 2))], options);
    expect(problems).toEqual([
      { sheet: '', row: 2, code: 'unknown_sheet' },
      { sheet: '', row: 3, code: 'unknown_sheet' },
    ]);
  });

  it('Journey Rules is reported sheet_ignored', () => {
    const { problems } = planImport(
      [{ sheet: 'Journey Rules', rows: [] }, sheet('TS', tsRows)],
      options
    );
    expect(problems).toEqual([
      { sheet: 'Journey Rules', row: null, code: 'sheet_ignored' },
    ]);
  });

  it('an unknown platform is reported with its row', () => {
    const { problems } = planImport(
      [sheet('TS', [['A', 'SMS Blast', 'D0', 'x']])],
      options
    );
    expect(problems).toEqual([
      { sheet: 'TS', row: 2, code: 'unknown_platform', column: 'Platform' },
    ]);
  });

  it('an inherited property name is not a platform', () => {
    const { problems } = planImport(
      [sheet('TS', [['A', 'constructor', 'D0', 'x']])],
      options
    );
    expect(problems.map((p) => p.code)).toEqual(['unknown_platform']);
  });

  it('a missing Timing column fails the sheet with missing_column', () => {
    const broken = sheet('TS', tsRows);
    for (const row of broken.rows) {
      delete row.cells.Timing;
    }
    const { journeys, problems } = planImport([broken], options);
    expect(journeys).toEqual([]);
    expect(problems).toEqual([
      { sheet: 'TS', row: null, code: 'missing_column', column: 'Timing' },
    ]);
  });

  it('reports unparsed_timing and duplicate_timing', () => {
    const { journeys, problems } = planImport(
      [
        sheet('TS', [
          ['A', PLATFORM, 'tomorrow', 'x'],
          ['A', PLATFORM, 'D0', 'x'],
          ['A', PLATFORM, 'D0 on exit', 'y'],
        ]),
      ],
      options
    );
    expect(problems.map((p) => [p.row, p.code])).toEqual([
      [2, 'unparsed_timing'],
      [4, 'duplicate_timing'],
    ]);
    expect(journeys[0]?.definition.steps).toHaveLength(1);
  });

  it('too long a message and too many steps are reported', () => {
    const many: Row[] = Array.from({ length: 21 }, (_, i) => [
      'Long',
      PLATFORM,
      `D${i}`,
      'x',
    ]);
    const { journeys, problems } = planImport(
      [
        sheet('TS', many),
        sheet('AP', [['Big', PLATFORM, 'D0', 'x'.repeat(20_001)]]),
      ],
      options
    );
    expect(journeys).toEqual([]);
    expect(problems.map((p) => p.code).sort()).toEqual([
      'message_too_long',
      'too_many_steps',
    ]);
  });

  it('reports definition_too_large', () => {
    const rows: Row[] = Array.from({ length: 20 }, (_, i) => [
      'Huge',
      PLATFORM,
      `D${i}`,
      'x'.repeat(5000),
    ]);
    const states: Record<string, string> = {};
    const sheets = Array.from({ length: 3 }, (_, i) => {
      states[`S${i}`] = `S${i}`;
      return sheet(`S${i}`, rows);
    });
    const { journeys, problems } = planImport(sheets, { states });
    expect(journeys).toEqual([]);
    expect(problems.map((p) => p.code)).toEqual(['definition_too_large']);
  });

  it('guessed trigger and goal are flagged unconfirmed and supplied ones are not', () => {
    const guessed = planImport([sheet('TS', tsRows)], options).journeys;
    const registration = guessed.find((j) => j.key === 'registration_started');
    expect(registration?.unconfirmed).toEqual(['trigger', 'goal']);
    expect(registration?.definition.trigger.event).toBe('registration_started');
    expect(registration?.definition.goal).toEqual({
      kind: 'event',
      event: GOAL_GUESSES.registration_started ?? '',
    });
    expect(
      guessed.find((j) => j.key === 'invalid_pin_otp')?.definition.goal
    ).toEqual({ kind: 'event', event: 'invalid_pin_otp_resolved' });
    const supplied = planImport([sheet('TS', tsRows)], {
      ...options,
      journeys: {
        registration_started: { triggerEvent: 'reg', goalEvent: 'done' },
        cart_abandoned: { goalEvent: 'bought' },
      },
    }).journeys;
    const suppliedRegistration = supplied.find(
      (j) => j.key === 'registration_started'
    );
    expect(suppliedRegistration?.unconfirmed).toEqual([]);
    expect(suppliedRegistration?.definition.trigger.event).toBe('reg');
    expect(
      supplied.find((j) => j.key === 'cart_abandoned')?.unconfirmed
    ).toEqual(['trigger']);
  });

  it('an inherited key name is not a goal guess', () => {
    const { journeys } = planImport(
      [sheet('TS', [['constructor', PLATFORM, 'D0', 'x']])],
      options
    );
    expect(journeys[0]?.definition.goal).toEqual({
      kind: 'event',
      event: 'constructor_resolved',
    });
  });

  it('notes carry instructions and visual, and are truncated', () => {
    const long = planImport(
      [
        sheet('TS', [['A', PLATFORM, 'D0', 'x']], {
          Instructions: 'i'.repeat(3000),
          'Template Idea (Image/Visual)': 'v',
        }),
      ],
      options
    );
    expect(long.journeys[0]?.definition.steps[0]?.note).toHaveLength(2000);
    const short = planImport(
      [
        sheet('TS', [['A', PLATFORM, 'D0', 'x']], {
          Instructions: 'do it',
          'Template Idea (Image/Visual)': 'pic',
        }),
      ],
      options
    );
    expect(short.journeys[0]?.definition.steps[0]?.note).toBe(
      'do it\nVisual: pic'
    );
  });

  it('no problem carries message text', () => {
    const { problems } = planImport(
      [
        sheet('TS', [
          ...tsRows,
          ['A', 'Nope', 'D0', MESSAGES[0] ?? ''],
          ['A', PLATFORM, 'D2 on next thing', MESSAGES[1] ?? ''],
          ['A', PLATFORM, 'whenever', MESSAGES[2] ?? ''],
        ]),
        sheet('', [['A', PLATFORM, 'D0', MESSAGES[0] ?? '']]),
      ],
      options
    );
    expect(problems.length).toBeGreaterThan(0);
    const text = JSON.stringify(problems);
    for (const message of MESSAGES) {
      expect(text).not.toContain(message);
    }
  });
});
