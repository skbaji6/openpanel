import {
  MAX_BODY_LENGTH,
  MAX_DEFINITION_BYTES,
  MAX_DELAY_SECONDS,
  MAX_NOTE_LENGTH,
  MAX_STEPS,
  type RuleDefinition,
  type Step,
  zRuleDefinition,
} from '../rules/rule.schema';
import type { SheetRows } from './xlsx-reader';

const SECONDS_PER_DAY = 86_400;
const REENTRY_COOLDOWN_DAYS = 21;

export const REQUIRED_COLUMNS = [
  'Event Name',
  'Platform',
  'Timing',
  'Message (Content)',
] as const;
const INSTRUCTIONS_COLUMN = 'Instructions';
const VISUAL_COLUMN = 'Template Idea (Image/Visual)';
export const IGNORED_SHEETS = ['Journey Rules'];
export const PLATFORM_CHANNELS = { 'In-App Notification': 'push' } as const;
export const TIMING =
  /^D(\d{1,2})(?:\s+(Immediate|in session|on exit|after exit|confirmation))?$/i;
export const CONDITIONAL_TIMING = /^D\d{1,2}\s+on next /i;
export const IMPORT_REENTRY = {
  enabled: true,
  cooldownSeconds: REENTRY_COOLDOWN_DAYS * SECONDS_PER_DAY,
};

export const GOAL_GUESSES: Record<string, string> = {
  registration_started: 'registration_completed',
  incomplete_registration: 'registration_completed',
  registration_completed: 'course_selection_completed',
  home_page_view: 'course_selection_completed',
  book_sample_viewed: 'sample_read_continued',
  books_added_to_cart: 'cart_reviewed',
  cart_abandoned: 'purchase_success',
  payment_failed: 'payment_issue_resolved',
  mentor_viewed: 'mentor_interest_confirmed',
  mentor_notify_click: 'mentor_interest_confirmed',
};

export type ImportOptions = {
  states: Record<string, string>;
  journeys?: Record<string, { triggerEvent?: string; goalEvent?: string }>;
  overwriteEdited?: boolean;
};

export type ImportProblem = {
  sheet: string;
  row: number | null;
  code:
    | 'unknown_sheet'
    | 'sheet_ignored'
    | 'missing_column'
    | 'empty_message'
    | 'unknown_platform'
    | 'unparsed_timing'
    | 'conditional_timing'
    | 'duplicate_timing'
    | 'message_too_long'
    | 'invalid_placeholder'
    | 'too_many_steps'
    | 'definition_too_large';
  column?: string;
};

export type PlannedJourney = {
  key: string;
  name: string;
  definition: RuleDefinition;
  unconfirmed: ('trigger' | 'goal')[];
};

type DraftStep = { variants: Record<string, { body: string }>; note?: string };
type DraftJourney = {
  name: string;
  firstSheet: string;
  steps: Map<number, DraftStep>;
};

export function journeyKeyOf(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function cell(cells: Record<string, string>, column: string): string {
  return Object.hasOwn(cells, column) ? (cells[column] ?? '').trim() : '';
}

function delayOf(timing: string): number | null {
  const days = TIMING.exec(timing)?.[1];
  if (days === undefined) {
    return null;
  }
  const delay = Number(days) * SECONDS_PER_DAY;
  return delay > MAX_DELAY_SECONDS ? null : delay;
}

function noteOf(cells: Record<string, string>): string | undefined {
  const visual = cell(cells, VISUAL_COLUMN);
  const parts = [
    cell(cells, INSTRUCTIONS_COLUMN),
    visual === '' ? '' : `Visual: ${visual}`,
  ].filter((part) => part !== '');
  return parts.length === 0
    ? undefined
    : parts.join('\n').slice(0, MAX_NOTE_LENGTH);
}

function missingColumns(sheet: SheetRows): string[] {
  const first = sheet.rows[0];
  if (!first) {
    return [];
  }
  return REQUIRED_COLUMNS.filter(
    (column) => !Object.hasOwn(first.cells, column)
  );
}

// The renderer turns any other placeholder into empty text ("Hi , your cart"), so it is refused at import.
const VALID_PLACEHOLDER = /^(?:missing|(?:profile|event)\.[^.\s][^\s]*)$/;
const PLACEHOLDER_TOKEN = /\{\{([^{}]*)\}\}/g;

function hasInvalidPlaceholder(body: string): boolean {
  return [...body.matchAll(PLACEHOLDER_TOKEN)].some(
    ([, path]) => !VALID_PLACEHOLDER.test((path ?? '').trim())
  );
}

type RowOutcome = ImportProblem['code'] | null;

function planRow(
  journeys: Map<string, DraftJourney>,
  sheet: string,
  state: string,
  cells: Record<string, string>
): RowOutcome {
  const label = cell(cells, 'Event Name');
  const key = journeyKeyOf(label);
  if (key === '') {
    return 'missing_column';
  }
  if (!Object.hasOwn(PLATFORM_CHANNELS, cell(cells, 'Platform'))) {
    return 'unknown_platform';
  }
  const timing = cell(cells, 'Timing');
  if (CONDITIONAL_TIMING.test(timing)) {
    return 'conditional_timing';
  }
  const delay = delayOf(timing);
  if (delay === null) {
    return 'unparsed_timing';
  }
  const body = cell(cells, 'Message (Content)');
  if (body === '') {
    return 'empty_message';
  }
  if (body.length > MAX_BODY_LENGTH) {
    return 'message_too_long';
  }
  if (hasInvalidPlaceholder(body)) {
    return 'invalid_placeholder';
  }
  let journey = journeys.get(key);
  if (!journey) {
    journey = { name: label, firstSheet: sheet, steps: new Map() };
    journeys.set(key, journey);
  }
  let step = journey.steps.get(delay);
  if (!step) {
    step = { variants: Object.create(null) };
    journey.steps.set(delay, step);
  }
  if (Object.hasOwn(step.variants, state)) {
    return 'duplicate_timing';
  }
  step.variants[state] = { body };
  step.note ??= noteOf(cells);
  return null;
}

const COLUMN_OF_CODE: Partial<Record<ImportProblem['code'], string>> = {
  missing_column: 'Event Name',
  unknown_platform: 'Platform',
  unparsed_timing: 'Timing',
  conditional_timing: 'Timing',
  duplicate_timing: 'Timing',
  empty_message: 'Message (Content)',
  message_too_long: 'Message (Content)',
  invalid_placeholder: 'Message (Content)',
};

function problemFor(
  sheet: string,
  row: number,
  code: ImportProblem['code']
): ImportProblem {
  const column = COLUMN_OF_CODE[code];
  return column === undefined
    ? { sheet, row, code }
    : { sheet, row, code, column };
}

function buildDefinition(
  key: string,
  journey: DraftJourney,
  options: ImportOptions
): PlannedJourney {
  const supplied = Object.hasOwn(options.journeys ?? {}, key)
    ? options.journeys?.[key]
    : undefined;
  const guessedGoal = Object.hasOwn(GOAL_GUESSES, key)
    ? GOAL_GUESSES[key]
    : undefined;
  const unconfirmed: PlannedJourney['unconfirmed'] = [];
  if (!supplied?.triggerEvent) {
    unconfirmed.push('trigger');
  }
  if (!supplied?.goalEvent) {
    unconfirmed.push('goal');
  }
  const steps: Step[] = [...journey.steps.entries()]
    .sort(([a], [b]) => a - b)
    .map(([delaySeconds, step]) => ({
      delaySeconds,
      channel: 'push',
      variants: step.variants,
      ...(step.note === undefined ? {} : { note: step.note }),
    }));
  return {
    key,
    name: journey.name,
    unconfirmed,
    definition: {
      name: journey.name,
      trigger: { event: supplied?.triggerEvent || key },
      goal: {
        kind: 'event',
        event: supplied?.goalEvent || guessedGoal || `${key}_resolved`,
      },
      steps,
      reentry: { ...IMPORT_REENTRY },
      allowedEventProps: [],
    },
  };
}

export function planImport(
  sheets: SheetRows[],
  options: ImportOptions
): { journeys: PlannedJourney[]; problems: ImportProblem[] } {
  const problems: ImportProblem[] = [];
  const drafts = new Map<string, DraftJourney>();
  for (const sheet of sheets) {
    if (IGNORED_SHEETS.includes(sheet.sheet)) {
      problems.push({ sheet: sheet.sheet, row: null, code: 'sheet_ignored' });
      continue;
    }
    if (sheet.sheet === '') {
      for (const row of sheet.rows) {
        problems.push({ sheet: '', row: row.rowNumber, code: 'unknown_sheet' });
      }
      continue;
    }
    if (!Object.hasOwn(options.states, sheet.sheet)) {
      problems.push({ sheet: sheet.sheet, row: null, code: 'unknown_sheet' });
      continue;
    }
    const missing = missingColumns(sheet);
    if (missing.length > 0) {
      for (const column of missing) {
        problems.push({
          sheet: sheet.sheet,
          row: null,
          code: 'missing_column',
          column,
        });
      }
      continue;
    }
    const state = options.states[sheet.sheet] ?? '';
    for (const row of sheet.rows) {
      const code = planRow(drafts, sheet.sheet, state, row.cells);
      if (code) {
        problems.push(problemFor(sheet.sheet, row.rowNumber, code));
      }
    }
  }
  const journeys: PlannedJourney[] = [];
  for (const [key, draft] of drafts) {
    if (draft.steps.size > MAX_STEPS) {
      problems.push({
        sheet: draft.firstSheet,
        row: null,
        code: 'too_many_steps',
      });
      continue;
    }
    const planned = buildDefinition(key, draft, options);
    const isTooLarge =
      Buffer.byteLength(JSON.stringify(planned.definition)) >
      MAX_DEFINITION_BYTES;
    if (isTooLarge || !zRuleDefinition.safeParse(planned.definition).success) {
      problems.push({
        sheet: draft.firstSheet,
        row: null,
        code: 'definition_too_large',
      });
      continue;
    }
    journeys.push(planned);
  }
  return { journeys, problems };
}
