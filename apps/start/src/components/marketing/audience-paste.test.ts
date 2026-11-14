import { describe, expect, test } from 'vitest';
import { MarketingApiError } from './api';
import {
  addIdsInChunks,
  describePasteError,
  describeProgress,
  parseContactInput,
  resolveContacts,
} from './audience-paste';
import type { AudienceRow, ResolveResponse } from './campaign-contract';

describe('parseContactInput', () => {
  test('splits on newlines and commas only, so spaced phone numbers stay whole', () => {
    expect(
      parseContactInput('+91 98765 43210\n\nada@example.com, +91 98765 43210')
    ).toEqual({
      entries: [
        { value: '+91 98765 43210', line: 1 },
        { value: 'ada@example.com', line: 3 },
      ],
      tooLongLines: [],
    });
  });

  test('flags entries longer than the server accepts by line number', () => {
    const long = 'x'.repeat(257);
    expect(parseContactInput(`a@b.co\n${long}`)).toEqual({
      entries: [{ value: 'a@b.co', line: 1 }],
      tooLongLines: [2],
    });
  });
});

describe('describeProgress', () => {
  test('formats both numbers', () => {
    expect(describeProgress('Checking', 400, 1200)).toBe(
      'Checking 400 of 1,200'
    );
  });
});

describe('resolveContacts', () => {
  test('sends chunks of 200 one after another and maps unmatched positions to lines', async () => {
    const entries = Array.from({ length: 450 }, (_, index) => ({
      value: `user${index}@example.com`,
      line: index + 1,
    }));
    const sent: number[] = [];
    const progress: number[] = [];
    let inFlight = 0;
    const result = await resolveContacts(
      entries,
      async (inputs): Promise<ResolveResponse> => {
        inFlight += 1;
        expect(inFlight).toBe(1);
        sent.push(inputs.length);
        await Promise.resolve();
        inFlight -= 1;
        // The first input of each chunk is unknown; the rest resolve to ids.
        return {
          ids: inputs.slice(1).map((input) => `id-${input}`),
          unmatchedPositions: [0],
        };
      },
      (done) => progress.push(done)
    );
    expect(sent).toEqual([200, 200, 50]);
    expect(progress).toEqual([200, 400, 450]);
    expect(result.ids).toHaveLength(447);
    expect(result.unmatchedLines).toEqual([1, 201, 401]);
  });

  test('de-duplicates ids that two contacts resolve to', async () => {
    const result = await resolveContacts(
      [
        { value: 'a@b.co', line: 1 },
        { value: '+911234567890', line: 2 },
      ],
      async () => ({ ids: ['same'], unmatchedPositions: [] }),
      () => undefined
    );
    expect(result.ids).toEqual(['same']);
  });
});

describe('addIdsInChunks', () => {
  const row = (version: number) => ({ version }) as AudienceRow;

  test('threads the returned version through chunks of 2000', async () => {
    const ids = Array.from({ length: 4500 }, (_, index) => `id${index}`);
    const calls: { size: number; expectedVersion: number }[] = [];
    const seen: number[] = [];
    const last = await addIdsInChunks({
      ids,
      version: 3,
      post: async (chunk, expectedVersion) => {
        calls.push({ size: chunk.length, expectedVersion });
        return row(expectedVersion + 1);
      },
      onChunk: (saved, done) => seen.push(saved.version, done),
    });
    expect(calls).toEqual([
      { size: 2000, expectedVersion: 3 },
      { size: 2000, expectedVersion: 4 },
      { size: 500, expectedVersion: 5 },
    ]);
    expect(seen).toEqual([4, 2000, 5, 4000, 6, 4500]);
    expect(last?.version).toBe(6);
  });

  test('no ids, no calls', async () => {
    const last = await addIdsInChunks({
      ids: [],
      version: 1,
      post: () => {
        throw new Error('not called');
      },
      onChunk: () => undefined,
    });
    expect(last).toBeNull();
  });
});

describe('describePasteError', () => {
  test('uses the label only, never the issue text', () => {
    const error = new MarketingApiError(
      400,
      'invalid_body',
      [{ path: 'inputs.0', message: 'ada@example.com is too long' }],
      null
    );
    expect(describePasteError(error)).toBe(
      'The request was not valid. Check the fields and try again.'
    );
  });

  test('falls back for unlabelled codes and other errors', () => {
    expect(
      describePasteError(new MarketingApiError(500, 'http_500', [], null))
    ).toBe('The check failed. Try again in a moment.');
    expect(describePasteError(new Error('ada@example.com'))).toBe(
      'The check failed. Try again in a moment.'
    );
  });
});
