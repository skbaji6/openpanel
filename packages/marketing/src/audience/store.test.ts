import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { HttpError } from '../api/http';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import type { FilterTree, Schema } from './contract';
import { MAX_IDS_PER_CHANGE, MAX_LIST_IDS } from './definition';
import { createFakeSource, type FakeMember } from './fake-source';
import type { AudienceSource } from './source';
import { createAudienceStore } from './store';

const PROJECT = 'p1';
const OTHER_PROJECT = 'p2';
const CTX = { projectId: PROJECT, userId: 'u1' };
const NOW = new Date('2026-11-03T10:00:00.000Z');
const PRO: FilterTree = { dimension: 'plan', op: 'eq', values: ['pro'] };
const SCHEMA: Schema = {
  dimensions: [
    {
      key: 'plan',
      label: 'Plan',
      type: 'string',
      multiValued: false,
      valuesListable: true,
    },
  ],
};
const PRO_COUNT = 30;
const CHUNKS = MAX_LIST_IDS / MAX_IDS_PER_CHANGE;

const pad = (n: number) => String(n).padStart(6, '0');
const ids = (prefix: string, count: number, from = 1) =>
  Array.from({ length: count }, (_, i) => `${prefix}-${pad(from + i)}`);

let down = false;
let members: FakeMember[] = [];
let hasSource = true;

function makeStore() {
  const source: AudienceSource = createFakeSource({
    members,
    schema: SCHEMA,
    down: () => down,
  });
  return createAudienceStore({
    sql,
    source: async (projectId) =>
      hasSource && projectId === PROJECT ? source : null,
    now: () => NOW,
  });
}

async function caught(promise: Promise<unknown>): Promise<HttpError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  );
  if (!(error instanceof HttpError)) {
    throw new Error(`expected an HttpError, got ${String(error)}`);
  }
  return error;
}

async function snapshotRows(audienceId: string) {
  return await sql.$queryRawUnsafe<
    { snapshot_version: number; profile_id: string }[]
  >(
    `SELECT snapshot_version, profile_id FROM marketing.audience_snapshot_ids
     WHERE audience_id = $1::uuid ORDER BY snapshot_version, profile_id`,
    audienceId
  );
}

async function stagedRows(): Promise<number> {
  const [row] = await sql.$queryRawUnsafe<{ n: number }[]>(
    'SELECT count(*)::int AS n FROM marketing.materialize_exclusions'
  );
  return row?.n ?? 0;
}

async function insertCampaign(audienceId: string, state: string) {
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.campaigns (id, project_id, name, state, channel, template, audience_id, confirm_threshold, created_by)
     VALUES (gen_random_uuid(), $1, 'c', $2, 'push', '{}'::jsonb, $3::uuid, 5000, 'u1')`,
    PROJECT,
    state,
    audienceId
  );
}

const dynamicInput = {
  name: 'Pro users',
  mode: 'dynamic' as const,
  filter: PRO,
  excludeFilter: null,
};
const snapshotInput = { ...dynamicInput, mode: 'snapshot' as const };

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await resetMarketingTables();
  down = false;
  hasSource = true;
  members = [
    ...ids('pro', PRO_COUNT).map((id) => ({ id, values: { plan: 'pro' } })),
    ...ids('free', 5).map((id) => ({ id, values: { plan: 'free' } })),
  ];
});

describe('audience store', () => {
  it('a dynamic audience saves while the source is down and has schema_checked_at null', async () => {
    down = true;
    const store = makeStore();
    const row = await store.create(CTX, dynamicInput);
    expect(row).toMatchObject({
      projectId: PROJECT,
      name: 'Pro users',
      mode: 'dynamic',
      filter: PRO,
      version: 1,
      schemaCheckedAt: null,
      createdBy: 'u1',
      inUse: false,
      includeCount: 0,
    });
    down = false;
    const checked = await store.update(CTX, row.id, dynamicInput, 1);
    expect(checked.schemaCheckedAt).toBe(NOW.toISOString());
    expect(checked.version).toBe(2);
  });

  it('an undeclared dimension is rejected when the source is up', async () => {
    const error = await caught(
      makeStore().create(CTX, {
        ...dynamicInput,
        filter: { dimension: 'country', op: 'eq', values: ['IN'] },
      })
    );
    expect(error.status).toBe(400);
    expect(error.code).toBe('invalid_filter');
    expect(error.issues?.length).toBeGreaterThan(0);
  });

  it('adding 20,000 includes in ten chunks of 2,000 succeeds and one more id fails with ids_limit, leaving 20,000', async () => {
    const store = makeStore();
    let row = await store.create(CTX, dynamicInput);
    for (let chunk = 0; chunk < CHUNKS; chunk++) {
      row = await store.changeIds(
        CTX,
        row.id,
        {
          list: 'include',
          add: ids('inc', MAX_IDS_PER_CHANGE, chunk * MAX_IDS_PER_CHANGE + 1),
        },
        row.version
      );
    }
    expect(row.includeCount).toBe(MAX_LIST_IDS);
    const error = await caught(
      store.changeIds(
        CTX,
        row.id,
        { list: 'include', add: ['one-more'] },
        row.version
      )
    );
    expect(error.status).toBe(400);
    expect(error.code).toBe('ids_limit');
    const after = await store.get(CTX, row.id);
    expect(after.includeCount).toBe(MAX_LIST_IDS);
    expect(after.version).toBe(row.version);
  });

  it('remove and clear change the count and bump the version', async () => {
    const store = makeStore();
    let row = await store.create(CTX, dynamicInput);
    row = await store.changeIds(
      CTX,
      row.id,
      { list: 'exclude', add: ['a', 'b', 'c'] },
      1
    );
    expect([row.excludeCount, row.version]).toEqual([3, 2]);
    row = await store.changeIds(
      CTX,
      row.id,
      { list: 'exclude', remove: ['b'] },
      2
    );
    expect([row.excludeCount, row.version]).toEqual([2, 3]);
    expect(await store.listIds(CTX, row.id, 'exclude', null, 1)).toEqual({
      ids: ['a'],
      nextCursor: 'a',
    });
    expect(await store.listIds(CTX, row.id, 'exclude', 'a', 1)).toEqual({
      ids: ['c'],
      nextCursor: null,
    });
    row = await store.changeIds(
      CTX,
      row.id,
      { list: 'exclude', clear: true },
      3
    );
    expect([row.excludeCount, row.version]).toEqual([0, 4]);
  });

  it('a stale expectedVersion is version_conflict', async () => {
    const store = makeStore();
    const row = await store.create(CTX, dynamicInput);
    await store.update(CTX, row.id, { ...dynamicInput, name: 'v2' }, 1);
    for (const attempt of [
      () => store.update(CTX, row.id, { ...dynamicInput, name: 'v3' }, 1),
      () => store.changeIds(CTX, row.id, { list: 'include', add: ['x'] }, 1),
    ]) {
      const error = await caught(attempt());
      expect([error.status, error.code]).toEqual([409, 'version_conflict']);
    }
    expect((await store.get(CTX, row.id)).name).toBe('v2');
  });

  it('freeze stores the exact materialised set and snapshot_count', async () => {
    const store = makeStore();
    let row = await store.create(CTX, snapshotInput);
    row = await store.changeIds(
      CTX,
      row.id,
      { list: 'include', add: ['free-000001', 'hand-picked'] },
      1
    );
    row = await store.changeIds(
      CTX,
      row.id,
      { list: 'exclude', add: ['pro-000001'] },
      2
    );
    const frozen = await store.freeze(CTX, row.id);
    const expected = [
      'free-000001',
      'hand-picked',
      ...ids('pro', PRO_COUNT - 1, 2),
    ].sort();
    expect(frozen).toMatchObject({
      version: 3,
      snapshotVersion: 3,
      snapshotCount: expected.length,
      snapshotAt: NOW.toISOString(),
    });
    expect((await snapshotRows(row.id)).map((r) => r.profile_id)).toEqual(
      expected
    );
    expect(await stagedRows()).toBe(0);
  });

  it('freeze while the source is down returns source_unavailable and keeps the previous snapshot', async () => {
    const store = makeStore();
    const row = await store.create(CTX, snapshotInput);
    const frozen = await store.freeze(CTX, row.id);
    const before = await snapshotRows(row.id);
    down = true;
    expect(await store.freeze(CTX, row.id)).toEqual(frozen);
    const edited = await store.changeIds(
      CTX,
      row.id,
      { list: 'exclude', add: ['pro-000002'] },
      1
    );
    const error = await caught(store.freeze(CTX, row.id));
    expect([error.status, error.code]).toEqual([503, 'source_unavailable']);
    expect(await store.get(CTX, row.id)).toEqual(edited);
    expect(await stagedRows()).toBe(0);
    expect(edited).toMatchObject({
      snapshotVersion: frozen.snapshotVersion,
      snapshotCount: frozen.snapshotCount,
    });
    expect(await snapshotRows(row.id)).toEqual(before);
  });

  it('freeze after an edit replaces the old snapshot rows', async () => {
    const store = makeStore();
    const row = await store.create(CTX, snapshotInput);
    await store.freeze(CTX, row.id);
    await store.update(
      CTX,
      row.id,
      {
        ...snapshotInput,
        filter: { dimension: 'plan', op: 'eq', values: ['free'] },
      },
      1
    );
    const frozen = await store.freeze(CTX, row.id);
    expect(frozen).toMatchObject({ snapshotVersion: 2, snapshotCount: 5 });
    expect(await snapshotRows(row.id)).toEqual(
      ids('free', 5).map((profile_id) => ({ snapshot_version: 2, profile_id }))
    );
  });

  it('update, changeIds, freeze and remove on an audience used by a scheduled campaign are audience_in_use', async () => {
    const store = makeStore();
    const row = await store.create(CTX, snapshotInput);
    await insertCampaign(row.id, 'scheduled');
    expect((await store.get(CTX, row.id)).inUse).toBe(true);
    for (const attempt of [
      () => store.update(CTX, row.id, snapshotInput, 1),
      () => store.changeIds(CTX, row.id, { list: 'include', add: ['x'] }, 1),
      () => store.freeze(CTX, row.id),
      () => store.remove(CTX, row.id),
    ]) {
      const error = await caught(attempt());
      expect([error.status, error.code]).toEqual([409, 'audience_in_use']);
    }
    expect(await store.get(CTX, row.id)).toMatchObject({
      version: 1,
      snapshotVersion: null,
    });
  });

  it('the same audience used only by a completed campaign can be edited', async () => {
    const store = makeStore();
    const row = await store.create(CTX, snapshotInput);
    await insertCampaign(row.id, 'completed');
    expect((await store.get(CTX, row.id)).inUse).toBe(false);
    const edited = await store.changeIds(
      CTX,
      row.id,
      { list: 'include', add: ['x'] },
      1
    );
    expect(edited.version).toBe(2);
    expect((await store.freeze(CTX, row.id)).snapshotVersion).toBe(2);
    // Campaign history keeps its audience, so only the delete stays refused.
    const error = await caught(store.remove(CTX, row.id));
    expect([error.status, error.code]).toEqual([409, 'audience_in_use']);
  });

  it('a project without an http source gets source_not_http on freeze', async () => {
    hasSource = false;
    const store = makeStore();
    const row = await store.create(CTX, snapshotInput);
    const error = await caught(store.freeze(CTX, row.id));
    expect([error.status, error.code]).toEqual([409, 'source_not_http']);
  });

  it('freeze on a dynamic audience is not_snapshot', async () => {
    const store = makeStore();
    const row = await store.create(CTX, dynamicInput);
    const error = await caught(store.freeze(CTX, row.id));
    expect([error.status, error.code]).toEqual([409, 'not_snapshot']);
  });

  it("another project's audience is not_found", async () => {
    const store = makeStore();
    const row = await store.create(CTX, dynamicInput);
    const other = { projectId: OTHER_PROJECT, userId: 'u2' };
    for (const attempt of [
      () => store.get(other, row.id),
      () => store.update(other, row.id, dynamicInput, 1),
      () => store.changeIds(other, row.id, { list: 'include', add: ['x'] }, 1),
      () => store.listIds(other, row.id, 'include', null, 10),
      () => store.definition(other, row.id),
      () => store.freeze(other, row.id),
      () => store.remove(other, row.id),
    ]) {
      const error = await caught(attempt());
      expect([error.status, error.code]).toEqual([404, 'not_found']);
    }
    expect(await store.list(other)).toEqual([]);
    expect((await store.list(CTX)).map((a) => a.id)).toEqual([row.id]);
  });

  it('definition carries the lists and remove deletes the audience', async () => {
    const store = makeStore();
    const row = await store.create(CTX, dynamicInput);
    await store.changeIds(CTX, row.id, { list: 'exclude', add: ['b', 'a'] }, 1);
    expect(await store.definition(CTX, row.id)).toEqual({
      filter: PRO,
      excludeFilter: null,
      includeCount: 0,
      excludeIds: ['a', 'b'],
      excludeCount: 2,
    });
    await store.remove(CTX, row.id);
    const error = await caught(store.get(CTX, row.id));
    expect(error.code).toBe('not_found');
  });
});
