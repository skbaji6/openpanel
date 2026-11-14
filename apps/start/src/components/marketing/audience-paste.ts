import { MarketingApiError } from './api';
import { chunkIds, formatCount } from './audience-filter';
import {
  type AudienceRow,
  MAX_IDS_PER_CHANGE,
  MAX_RESOLVE_DISTINCT_INPUTS,
  MAX_RESOLVE_INPUT_LENGTH,
  type ResolveResponse,
} from './campaign-contract';
import { ERROR_LABELS } from './error-labels';

// Phone numbers are often written with spaces, so only newlines and commas separate entries.
const CONTACT_SEPARATORS = /[\n,]/;
const LINE_BREAK = /\r?\n/;
const PASTE_FAILED = 'The check failed. Try again in a moment.';

export interface ContactEntry {
  value: string;
  line: number;
}

export function parseContactInput(text: string): {
  entries: ContactEntry[];
  tooLongLines: number[];
} {
  const entries: ContactEntry[] = [];
  const tooLongLines: number[] = [];
  const seen = new Set<string>();
  for (const [index, lineText] of text.split(LINE_BREAK).entries()) {
    const line = index + 1;
    for (const part of lineText.split(CONTACT_SEPARATORS)) {
      const value = part.trim();
      if (value === '' || seen.has(value)) {
        continue;
      }
      seen.add(value);
      if (value.length > MAX_RESOLVE_INPUT_LENGTH) {
        tooLongLines.push(line);
        continue;
      }
      entries.push({ value, line });
    }
  }
  return { entries, tooLongLines };
}

export function describeProgress(
  verb: string,
  done: number,
  total: number
): string {
  return `${verb} ${formatCount(done)} of ${formatCount(total)}`;
}

// Sequential on purpose: the audience API is rate limited per project.
export async function resolveContacts(
  entries: ContactEntry[],
  resolveChunk: (inputs: string[]) => Promise<ResolveResponse>,
  onProgress: (done: number) => void
): Promise<{ ids: string[]; unmatchedLines: number[] }> {
  const ids = new Set<string>();
  const unmatchedLines: number[] = [];
  let done = 0;
  for (const chunk of chunkIds(entries, MAX_RESOLVE_DISTINCT_INPUTS)) {
    const result = await resolveChunk(chunk.map((entry) => entry.value));
    for (const id of result.ids) {
      ids.add(id);
    }
    for (const position of result.unmatchedPositions) {
      const entry = chunk[position];
      if (entry) {
        unmatchedLines.push(entry.line);
      }
    }
    done += chunk.length;
    onProgress(done);
  }
  return { ids: [...ids], unmatchedLines };
}

export async function addIdsInChunks({
  ids,
  version,
  post,
  onChunk,
}: {
  ids: string[];
  version: number;
  post: (chunk: string[], expectedVersion: number) => Promise<AudienceRow>;
  onChunk: (row: AudienceRow, done: number) => void;
}): Promise<AudienceRow | null> {
  let latest: AudienceRow | null = null;
  let expectedVersion = version;
  let done = 0;
  for (const chunk of chunkIds(ids, MAX_IDS_PER_CHANGE)) {
    latest = await post(chunk, expectedVersion);
    expectedVersion = latest.version;
    done += chunk.length;
    onChunk(latest, done);
  }
  return latest;
}

// Issue texts and raw messages could echo pasted contact details, so only the code's label is shown.
export function describePasteError(error: unknown): string {
  if (!(error instanceof MarketingApiError)) {
    return PASTE_FAILED;
  }
  return ERROR_LABELS[error.code] ?? PASTE_FAILED;
}
