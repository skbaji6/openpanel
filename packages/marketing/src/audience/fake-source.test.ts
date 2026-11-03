import { describe, expect, it } from 'bun:test';
import type { FilterTree } from './contract';
import { SourceProtocolError, SourceUnavailableError } from './errors';
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
        { id: 'a', values: {}, contact: { phone: '+15551234567' } },
        { id: 'b', values: {}, contact: { email: 'b@x.co' } },
      ],
    });
    expect(await source.resolve(['+15551234567', 'b@x.co', '+999'])).toEqual({
      matches: [
        { input: '+15551234567', id: 'a' },
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

const everyoneFilter: FilterTree = { dimension: 'n', op: 'exists', values: [] };
const idsOf = (page: { members: { id: string }[] }) =>
  page.members.map((m) => m.id);

describe('fake audience source timing', () => {
  it('counts an injected sleep explicitly and real elapsed time otherwise', async () => {
    const injected = createFakeSource({
      members: [{ id: 'a', values: { n: 1 } }],
      pageDelayMs: 250,
      sleep: () => Promise.resolve(),
      now: () => 0,
    });
    await injected.members({ filter: everyoneFilter, limit: 1, fields: 'id' });
    expect(injected.sourceTimeMs()).toBe(250);

    let tick = 0;
    const real = createFakeSource({
      members: [{ id: 'a', values: { n: 1 } }],
      pageDelayMs: 1,
      now: () => {
        tick += 5;
        return tick;
      },
    });
    await real.members({ filter: everyoneFilter, limit: 1, fields: 'id' });
    expect(real.sourceTimeMs()).toBe(5);
  });
});

describe('fake audience source contract limits', () => {
  const source = createFakeSource({
    members: [{ id: 'a', values: { n: 1 } }],
    schema: {
      dimensions: [
        {
          key: 'n',
          label: 'N',
          type: 'number',
          multiValued: false,
          valuesListable: false,
        },
      ],
    },
  });
  const request = (filter: FilterTree, limit = 10) =>
    source.members({ filter, limit, fields: 'id' });

  it('rejects a page limit above 1,000', async () => {
    await expect(request(everyoneFilter, 1001)).rejects.toBeInstanceOf(
      SourceProtocolError
    );
  });

  it('rejects a filter deeper than three levels', async () => {
    const deep: FilterTree = {
      op: 'and',
      children: [
        {
          op: 'and',
          children: [{ op: 'and', children: [everyoneFilter] }],
        },
      ],
    };
    await expect(request(deep)).rejects.toBeInstanceOf(SourceProtocolError);
  });

  it('rejects an id condition with too many values or a wrong op', async () => {
    const many = Array.from({ length: 1001 }, (_, i) => `i${i}`);
    await expect(
      source.count({ dimension: 'id', op: 'in', values: many })
    ).rejects.toBeInstanceOf(SourceProtocolError);
    await expect(
      source.count({ dimension: 'id', op: 'eq', values: ['a'] })
    ).rejects.toBeInstanceOf(SourceProtocolError);
  });

  it('rejects an undeclared dimension when a schema is given', async () => {
    await expect(
      source.count({ dimension: 'nope', op: 'exists', values: [] })
    ).rejects.toBeInstanceOf(SourceProtocolError);
  });

  it('rejects lookup above 500 ids and resolve above 200 inputs', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `i${i}`);
    await expect(source.lookup(ids, 'none')).rejects.toBeInstanceOf(
      SourceProtocolError
    );
    const inputs = Array.from({ length: 201 }, (_, i) => `u${i}@x.co`);
    await expect(source.resolve(inputs)).rejects.toBeInstanceOf(
      SourceProtocolError
    );
  });
});

describe('fake audience source resolve', () => {
  const source = createFakeSource({
    members: [
      { id: 'a', values: {}, contact: { phone: '+91 98765 43210' } },
      { id: 'b', values: {}, contact: { email: ' Ann@X.co ' } },
      { id: 'c', values: {}, contact: { email: 'dup@x.co' } },
      { id: 'd', values: {}, contact: { email: 'DUP@x.co' } },
    ],
  });

  it('folds emails, matches national phone digits, dedupes and keeps input order', async () => {
    const result = await source.resolve([
      'ann@x.co',
      '9876543210',
      ' ANN@x.co ',
      ' ann@x.co',
      '919876543210',
      'ghost@x.co',
    ]);
    expect(result.matches).toEqual([
      { input: 'ann@x.co', id: 'b' },
      { input: '9876543210', id: 'a' },
      { input: 'ANN@x.co', id: 'b' },
      { input: '919876543210', id: 'a' },
    ]);
    expect(result.unmatched).toEqual(['ghost@x.co']);
  });

  it('reports an input matching several members as unmatched', async () => {
    const result = await source.resolve(['dup@x.co']);
    expect(result).toEqual({ matches: [], unmatched: ['dup@x.co'] });
  });
});

describe('fake audience source lookup and suppression', () => {
  const source = createFakeSource({
    members: [
      {
        id: 'a',
        values: { n: 1 },
        displayName: 'A***',
        contact: { phone: '+91 98765 43210', email: 'a@x.co' },
        traits: { plan: 'pro' },
        devices: [{ token: 't', platform: 'ios' }],
      },
      { id: 'b', values: { n: 1 }, suppressed: true },
      {
        id: 'c',
        values: { n: 1 },
        contact: { email: 'c@x.co' },
        unreachable: { email: 'unverified_email' },
      },
    ],
  });

  it('returns one entry per distinct id in request order, honouring the channel', async () => {
    const email = await source.lookup(['c', 'a', 'a', 'zz'], 'email');
    expect(email.map((e) => [e.id, e.status])).toEqual([
      ['c', 'unreachable'],
      ['a', 'ok'],
      ['zz', 'not_found'],
    ]);
    expect(email[0]?.reason).toBe('unverified_email');
    expect(email[1]?.email).toBe('a@x.co');
    expect(email[1]?.phone).toBeUndefined();

    const [sms] = await source.lookup(['a'], 'sms');
    expect(sms?.phone).toBe('919876543210');
    expect(sms?.email).toBeUndefined();

    const [push] = await source.lookup(['a'], 'push');
    expect(push?.devices).toEqual([{ token: 't', platform: 'ios' }]);

    const [none] = await source.lookup(['a'], 'none');
    expect(none).toEqual({ id: 'a', status: 'ok', traits: { plan: 'pro' } });
  });

  it('uses the unreachable reason vocabulary', async () => {
    const [noPhone] = await source.lookup(['c'], 'whatsapp');
    expect(noPhone?.reason).toBe('no_valid_phone');
    const [noEmail] = await createFakeSource({
      members: [{ id: 'x', values: {} }],
    }).lookup(['x'], 'email');
    expect(noEmail?.reason).toBe('no_email');
    const [noDevice] = await source.lookup(['c'], 'push');
    expect(noDevice?.reason).toBe('no_active_device');
  });

  it('hides suppressed members from count, members and explain', async () => {
    expect((await source.count(everyoneFilter)).count).toBe(2);
    const page = await source.members({
      filter: everyoneFilter,
      limit: 10,
      fields: 'preview',
    });
    expect(idsOf(page)).toEqual(['a', 'c']);
    expect(page.members[0]?.displayName).toBe('A***');
    expect((await source.explain(everyoneFilter, 'b')).matches).toBe(false);
    const [entry] = await source.lookup(['b'], 'email');
    expect(entry?.status).toBe('suppressed');
  });

  it('matches stored numbers against string filter values and q case-insensitively', async () => {
    const typed = createFakeSource({
      members: [{ id: 'a', values: { n: 3, city: 'Pune' } }],
    });
    expect(
      (await typed.count({ dimension: 'n', op: 'eq', values: ['3'] })).count
    ).toBe(1);
    expect(await typed.dimensionValues('city', 'pu', 5)).toEqual([
      { value: 'Pune', label: 'Pune' },
    ]);
  });
});
