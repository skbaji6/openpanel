import type { DimensionValue } from './campaign-contract';
import type { ImportReport } from './contract';

const BASE64_CHUNK_BYTES = 0x80_00;

const IMPORT_PROBLEM_LABELS: Record<string, string> = {
  unknown_sheet: 'This sheet is not mapped to a state, so it was left out.',
  sheet_ignored: 'This sheet is not a journey sheet and was ignored.',
  missing_column: 'A required column is missing.',
  empty_message: 'The message is empty, so this row was left out.',
  unknown_platform:
    'The platform is not one we send to, so this row was left out.',
  unparsed_timing: 'The timing could not be read. Use a form like "Day 3".',
  conditional_timing:
    'Depends on something the student does next; not a timed step. Add it by hand if needed.',
  duplicate_timing:
    'Two rows have the same timing for this state, so one was left out.',
  message_too_long: 'The message is too long.',
  invalid_placeholder:
    'The message has a {{placeholder}} that is not valid, so this row was left out. Use {{profile.name}} style names.',
  too_many_steps: 'The journey has more steps than one journey can hold.',
  definition_too_large: 'The journey is too large to save.',
};

export function fileToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(
      ...bytes.subarray(start, start + BASE64_CHUNK_BYTES)
    );
  }
  return btoa(binary);
}

export function formatOf(fileName: string): 'xlsx' | 'csv' | null {
  const extension = fileName.toLowerCase().match(/\.(xlsx|csv)$/)?.[1];
  return extension === 'xlsx' || extension === 'csv' ? extension : null;
}

export function defaultStateMapping(
  sheets: string[],
  stateValues: DimensionValue[]
): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const sheet of sheets) {
    const wanted = sheet.trim().toLowerCase();
    const state = stateValues.find(
      (candidate) => candidate.label.trim().toLowerCase() === wanted
    );
    if (state) {
      mapping[sheet] = state.value;
    }
  }
  return mapping;
}

export const labelImportProblem = (code: string): string =>
  IMPORT_PROBLEM_LABELS[code] ?? code;

export function summarizeImport(report: ImportReport) {
  const keysWith = (action: string) =>
    report.journeys
      .filter((journey) => journey.action === action)
      .map((journey) => journey.key);
  const problemsBySheet: Record<
    string,
    { row: number | null; label: string }[]
  > = {};
  for (const problem of report.problems) {
    const list = problemsBySheet[problem.sheet] ?? [];
    list.push({ row: problem.row, label: labelImportProblem(problem.code) });
    problemsBySheet[problem.sheet] = list;
  }
  return {
    created: keysWith('created').length,
    updated: keysWith('updated').length,
    unchanged: keysWith('unchanged').length,
    skippedLive: keysWith('skipped_live'),
    skippedEdited: keysWith('skipped_edited'),
    problemsBySheet,
  };
}
