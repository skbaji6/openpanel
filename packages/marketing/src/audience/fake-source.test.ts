import { describe, expect, it } from 'bun:test';
import type { FilterTree } from './contract';
import { SourceUnavailableError } from './errors';
import { createFakeSource, type FakeMember } from './fake-source';

const PAGE = 1000;
const TOTAL = 2500;

const manyMembers: FakeMember[] = Array.from({ length: TOTAL }, (_, i) => ({
  id: `m${String(i).padStart(5, '0')}`,
  values: { tier: i % 2 === 0 ? 'gold' : 'basic', age: i % 100 },
}));

const everyone: FilterTree = {
  dimension: 'age',
  op: 'between',
  values: [0, 99],
};

async function pageAll(source: ReturnType<typeof createFakeSource>) {
  const ids: string[] = [];
  let cursor: string | undefined;
  let last: string | null = null;
  do {
    const page = await source.members({
      filter: everyone,
      cursor,
      limit: PAGE,
      fields: 'id',
    });
    ids.push(...page.members.map((m) => m.id));
    last = page.nextCursor;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return { ids, last };
}

describe('fake audience source', () => {
  it('pages 2,500 ids at 1,000 per page with no duplicates and a null final cursor', async () => {
    const { ids, last } = await pageAll(
      createFakeSource({ members: manyMembers })
    );
    expect(ids).toHaveLength(TOTAL);
    expect(new Set(ids).size).toBe(TOTAL);
    expect(ids).toEqual([...ids].sort());
    expect(last).toBeNull();
  });

  it('count equals ids paged for and, or and nested filters', async () => {
    const source = createFakeSource({ members: manyMembers });
    const gold: FilterTree = { dimension: 'tier', op: 'eq', values: ['gold'] };
    const young: FilterTree = { dimension: 'age', op: 'lt', values: [10] };
    const old: FilterTree = { dimension: 'age', op: 'gt', values: [89] };
    const filters: FilterTree[] = [
      { op: 'and', children: [gold, young] },
      { op: 'or', children: [young, old] },
      { op: 'and', children: [gold, { op: 'or', children: [young, old] }] },
    ];
    for (const filter of filters) {
      const { count } = await source.count(filter);
      const page = await source.members({ filter, limit: PAGE, fields: 'id' });
      expect(count).toBeGreaterThan(0);
      expect(page.members).toHaveLength(count);
    }
  });

  it('not_in on a multi-valued dimension excludes a member with any listed value', async () => {
    const source = createFakeSource({
      members: [
        { id: 'a', values: { tags: ['x', 'y'] } },
        { id: 'b', values: { tags: ['z'] } },
        { id: 'c', values: {} },
      ],
    });
    const page = await source.members({
      filter: { dimension: 'tags', op: 'not_in', values: ['x'] },
      limit: PAGE,
      fields: 'id',
    });
    expect(page.members.map((m) => m.id)).toEqual(['b', 'c']);
  });

  it('between is inclusive at both ends', async () => {
    const source = createFakeSource({
      members: [1, 2, 3, 4, 5].map((n) => ({ id: `m${n}`, values: { n } })),
    });
    const page = await source.members({
      filter: { dimension: 'n', op: 'between', values: [2, 4] },
      limit: PAGE,
      fields: 'id',
    });
    expect(page.members.map((m) => m.id)).toEqual(['m2', 'm3', 'm4']);
  });

  it('exists matches a present value only', async () => {
    const source = createFakeSource({
      members: [
        { id: 'a', values: { plan: 'pro' } },
        { id: 'b', values: {} },
      ],
    });
    const { count } = await source.count({
      dimension: 'plan',
      op: 'exists',
      values: [],
    });
    expect(count).toBe(1);
  });

  it('resolve returns ids for known phones and lists unknown inputs as unmatched', async () => {
    const source = createFakeSource({
      members: [
        { id: 'a', values: {}, contact: { phone: '+100' } },
        { id: 'b', values: {}, contact: { email: 'b@x.co' } },
      ],
    });
    expect(await source.resolve(['+100', 'b@x.co', '+999'])).toEqual({
      matches: [
        { input: '+100', id: 'a' },
        { input: 'b@x.co', id: 'b' },
      ],
      unmatched: ['+999'],
    });
  });

  it('down() makes members throw SourceUnavailableError', async () => {
    const source = createFakeSource({ members: [], down: () => true });
    await expect(
      source.members({ filter: everyone, limit: 1, fields: 'id' })
    ).rejects.toBeInstanceOf(SourceUnavailableError);
  });

  it('pageDelayMs is waited through the injected sleep and counted in sourceTimeMs', async () => {
    const waited: number[] = [];
    const source = createFakeSource({
      members: [{ id: 'a', values: { n: 1 } }],
      pageDelayMs: 250,
      sleep: (ms) => {
        waited.push(ms);
        return Promise.resolve();
      },
    });
    await source.members({ filter: everyone, limit: 10, fields: 'id' });
    expect(waited).toEqual([250]);
    expect(source.sourceTimeMs()).toBeGreaterThanOrEqual(250);
  });
});
