import { describe, expect, it } from 'bun:test';
import {
  countAudience,
  explainAudience,
  previewAudience,
  resolveInputs,
} from './builder';
import type { FilterTree } from './contract';
import type { AudienceDefinition } from './definition';
import { createFakeSource, type FakeMember } from './fake-source';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const now = () => NOW;
const MEMBER_COUNT = 60;
const GOLD_COUNT = MEMBER_COUNT / 2;
const SOME_EXCLUDES = 40;
const MANY_EXCLUDES = 1500;
const OVER_RESOLVE_LIMIT = 201;
const OVER_PREVIEW_LIMIT = 51;
const MAX_PREVIEW = 50;

const members: FakeMember[] = Array.from({ length: MEMBER_COUNT }, (_, i) => ({
  id: `m${String(i).padStart(4, '0')}`,
  values: { tier: i % 2 === 0 ? 'gold' : 'basic' },
  displayName: `Member ${i}`,
  contact: {
    email: `u${i}@example.com`,
    phone: `+9198000${String(i).padStart(5, '0')}`,
  },
}));
const source = () => createFakeSource({ members });
const gold: FilterTree = { dimension: 'tier', op: 'eq', values: ['gold'] };

const def = (
  over: Partial<AudienceDefinition> & { excludeCount?: number } = {}
) => ({
  filter: gold,
  excludeFilter: null,
  includeCount: 0,
  excludeIds: null,
  excludeCount: 0,
  ...over,
});
const fillerIds = (n: number) => Array.from({ length: n }, (_, i) => `x${i}`);

describe('countAudience', () => {
  it('count of a filter-only audience is exact', async () => {
    expect(await countAudience(source(), def(), now)).toEqual({
      count: GOLD_COUNT,
      approximate: false,
      countedAt: NOW.toISOString(),
      filterCount: GOLD_COUNT,
      includeCount: 0,
      excludeCount: 0,
    });
  });

  it('count with includes overlapping the filter is approximate and an upper bound', async () => {
    // m0000 is gold and hand-picked, so it is counted twice.
    const result = await countAudience(source(), def({ includeCount: 2 }), now);
    const actualSize = GOLD_COUNT + 1;
    expect(result.approximate).toBe(true);
    expect(result.count).toBeGreaterThanOrEqual(actualSize);
  });

  it('count with an exclude filter is approximate and an upper bound', async () => {
    const excludeFilter: FilterTree = {
      dimension: 'id',
      op: 'in',
      values: ['m0000'],
    };
    const result = await countAudience(source(), def({ excludeFilter }), now);
    expect(result.approximate).toBe(true);
    expect(result.count).toBeGreaterThanOrEqual(GOLD_COUNT - 1);
  });

  it('count with 40 excludes pushes not_in and is exact', async () => {
    const fake = source();
    const excludeIds = ['m0000', 'm0002', ...fillerIds(SOME_EXCLUDES - 2)];
    const result = await countAudience(
      fake,
      def({ excludeIds, excludeCount: SOME_EXCLUDES }),
      now
    );
    expect(result.approximate).toBe(false);
    expect(result.count).toBe(GOLD_COUNT - 2);
    expect(JSON.stringify(fake.calls.at(-1)?.filter)).toContain('not_in');
  });

  it('count with 1,500 excludes is approximate', async () => {
    const fake = source();
    const result = await countAudience(
      fake,
      def({
        excludeIds: fillerIds(MANY_EXCLUDES),
        excludeCount: MANY_EXCLUDES,
      }),
      now
    );
    expect(result.approximate).toBe(true);
    expect(result.count).toBe(GOLD_COUNT);
    expect(JSON.stringify(fake.calls.at(-1)?.filter)).not.toContain('not_in');
  });
});

describe('previewAudience', () => {
  it('preview limit 51 is rejected', async () => {
    const fake = source();
    await expect(
      previewAudience(fake, def(), undefined, OVER_PREVIEW_LIMIT)
    ).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
  });

  it('preview never returns an excluded id when excludes were pushed', async () => {
    const result = await previewAudience(
      source(),
      def({ excludeIds: ['m0000', 'm0002'], excludeCount: 2 }),
      undefined,
      MAX_PREVIEW
    );
    const got = result.members.map((m) => m.id);
    expect(got).not.toContain('m0000');
    expect(got).not.toContain('m0002');
    expect(result.members[0]?.displayName).toBeDefined();
  });
});

describe('explainAudience', () => {
  const base = {
    filter: gold,
    excludeFilter: null,
    included: false,
    excludedByList: false,
  };

  it('explain: a hand-picked id outside the filter is in with reason included', async () => {
    const result = await explainAudience(
      source(),
      { ...base, included: true },
      'm0001'
    );
    expect(result.verdict).toBe('in');
    expect(result.reasons).toEqual(['not_matched', 'included']);
  });

  it('explain: an id matching the filter and the exclude filter is out with excluded_by_filter', async () => {
    const excludeFilter: FilterTree = {
      dimension: 'id',
      op: 'in',
      values: ['m0000'],
    };
    const result = await explainAudience(
      source(),
      { ...base, excludeFilter },
      'm0000'
    );
    expect(result.verdict).toBe('out');
    expect(result.reasons).toEqual(['matched_filter', 'excluded_by_filter']);
  });

  it('explain: an excluded hand-picked id is out (exclusion wins)', async () => {
    const result = await explainAudience(
      source(),
      { ...base, included: true, excludedByList: true },
      'm0000'
    );
    expect(result.verdict).toBe('out');
    expect(result.reasons).toContain('excluded_by_list');
  });
});

describe('resolveInputs', () => {
  it('resolve maps positions of unmatched inputs and returns no input text', async () => {
    const raw = [
      ' u3@example.com ',
      'nobody@example.com',
      'u5@example.com',
      '',
      'u3@example.com',
    ];
    const result = await resolveInputs(source(), raw);
    expect(result).toEqual({
      ids: ['m0003', 'm0005'],
      unmatchedPositions: [1, 3],
    });
    expect(JSON.stringify(result)).not.toContain('example.com');
  });

  it('resolve with 201 inputs throws before any source call', async () => {
    const fake = source();
    const raw = Array.from(
      { length: OVER_RESOLVE_LIMIT },
      (_, i) => `u${i}@example.com`
    );
    const error = await resolveInputs(fake, raw).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('example.com');
    expect(fake.calls).toHaveLength(0);
  });
});
