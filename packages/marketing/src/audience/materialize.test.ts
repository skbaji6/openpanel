import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import type { Queryable } from '../engine/engine';
import type { FilterTree } from './contract';
import { MAX_SNAPSHOT_IDS } from './definition';
import { SourceProtocolError, SourceUnavailableError } from './errors';
import { createFakeSource, type FakeMember } from './fake-source';
import {
  type MaterializeJob,
  type MaterializeProgress,
  type MaterializeTarget,
  runMaterialization,
} from './materialize';
import type { AudienceSource } from './source';

const PROJECT = 'p1';
const PAGE_SIZE = 1000;
const MATCHING = 3000;
const PRO: FilterTree = { dimension: 'plan', op: 'eq', values: ['pro'] };
const CHURNED: FilterTree = {
  dimension: 'status',
  op: 'eq',
  values: ['churned'],
};
const DISPLAY_NAME = 'Ada Lovelace';
const PHONE = '+919812345678';
const EMAIL = 'ada@example.test';
const OVERLONG_ID_LENGTH = 257;

const pad = (n: number) => String(n).padStart(6, '0');
const proId = (n: number) => `pro-${pad(n)}`;
const freeId = (n: number) => `free-${pad(n)}`;

function range(count: number, from = 1): number[] {
  return Array.from({ length: count }, (_, i) => from + i);
}

function proMembers(count = MATCHING): FakeMember[] {
  return range(count).map((n) => ({
    id: proId(n),
    values: { plan: 'pro', status: n % 100 === 0 ? 'churned' : 'active' },
    displayName: DISPLAY_NAME,
    contact: { phone: PHONE, email: EMAIL },
  }));
}

function freeMembers(count: number): FakeMember[] {
  return range(count).map((n) => ({
    id: freeId(n),
    values: { plan: 'free', status: n <= 3 ? 'churned' : 'active' },
  }));
}

async function insertAudience(): Promise<string> {
  const [row] = await sql.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO marketing.audiences (id, project_id, name, mode, created_by)
     VALUES (gen_random_uuid(), $1, 'a', 'dynamic', 'u1') RETURNING id::text`,
    PROJECT
  );
  return row?.id as string;
}

async function insertCampaign(opts: {
  audienceId: string;
  projectId?: string;
  state?: string;
  key?: string | null;
}): Promise<{ id: string; token: string }> {
  const [row] = await sql.$queryRawUnsafe<{ id: string; token: string }[]>(
    `INSERT INTO marketing.campaigns (id, project_id, name, state, channel, template, audience_id, campaign_key,
       confirm_threshold, created_by, materialize_lease_token)
     VALUES (gen_random_uuid(), $1, 'c', $2, 'push', '{}'::jsonb, $3::uuid, $4, 5000, 'u1', gen_random_uuid())
     RETURNING id::text, materialize_lease_token::text AS token`,
    opts.projectId ?? PROJECT,
    opts.state ?? 'running',
    opts.audienceId,
    opts.key ?? null
  );
  return row as { id: string; token: string };
}

async function addIds(
  audienceId: string,
  list: 'include' | 'exclude',
  ids: string[]
) {
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.audience_ids (audience_id, list, profile_id)
     SELECT $1::uuid, $2, unnest($3::text[])`,
    audienceId,
    list,
    ids
  );
}

// The campaign row is the scratch row: its lease token is the claim.
function claimedSave(
  campaignId: string,
  token: string,
  inserted: number[] = []
): MaterializeJob['saveProgress'] {
  return async (tx: Queryable, next, count) => {
    inserted.push(count);
    const phase = next === 'done' ? 'done' : next.phase;
    const cursor = next === 'done' ? null : next.cursor;
    const updated = await tx.$executeRawUnsafe(
      `UPDATE marketing.campaigns SET materialize_phase = $2, materialize_cursor = $3
       WHERE id = $1::uuid AND materialize_lease_token = $4::uuid`,
      campaignId,
      phase,
      cursor,
      token
    );
    return updated === 1;
  };
}

async function savedProgress(
  campaignId: string
): Promise<MaterializeProgress | null> {
  const [row] = await sql.$queryRawUnsafe<
    { phase: MaterializeProgress['phase'] | null; cursor: string | null }[]
  >(
    'SELECT materialize_phase AS phase, materialize_cursor AS cursor FROM marketing.campaigns WHERE id = $1::uuid',
    campaignId
  );
  return row?.phase ? { phase: row.phase, cursor: row.cursor } : null;
}

async function recipients(campaignId: string): Promise<
  {
    profile_id: string;
    status: string;
    reason: string | null;
    project_id: string;
  }[]
> {
  return await sql.$queryRawUnsafe(
    `SELECT profile_id, status, reason, project_id FROM marketing.campaign_recipients
     WHERE campaign_id = $1::uuid ORDER BY profile_id`,
    campaignId
  );
}

async function recipientIds(campaignId: string): Promise<string[]> {
  return (await recipients(campaignId)).map((row) => row.profile_id);
}

async function stagingCount(): Promise<number> {
  const [row] = await sql.$queryRawUnsafe<{ n: number }[]>(
    'SELECT count(*)::int AS n FROM marketing.materialize_exclusions'
  );
  return row?.n ?? 0;
}

interface CampaignJobOptions {
  audienceId: string;
  campaign: { id: string; token: string };
  filter?: FilterTree | null;
  excludeFilter?: FilterTree | null;
  key?: string | null;
  skipPrevious?: boolean;
  progress?: MaterializeProgress | null;
  inserted?: number[];
}

function campaignJob(opts: CampaignJobOptions): MaterializeJob {
  const target: MaterializeTarget = {
    kind: 'campaign',
    campaignId: opts.campaign.id,
    campaignKey: opts.key ?? null,
    skipPrevious: opts.skipPrevious ?? false,
    fromSnapshot: null,
  };
  return {
    jobId: opts.campaign.id,
    projectId: PROJECT,
    audienceId: opts.audienceId,
    filter: opts.filter === undefined ? PRO : opts.filter,
    excludeFilter: opts.excludeFilter ?? null,
    target,
    progress: opts.progress ?? null,
    saveProgress: claimedSave(
      opts.campaign.id,
      opts.campaign.token,
      opts.inserted
    ),
  };
}

const sorted = (ids: Iterable<string>) => [...new Set(ids)].sort();

function wrapMembers(
  inner: AudienceSource,
  change: (
    req: Parameters<AudienceSource['members']>[0],
    page: Awaited<ReturnType<AudienceSource['members']>>
  ) => Awaited<ReturnType<AudienceSource['members']>>
): AudienceSource {
  return {
    ...inner,
    members: async (req) => change(req, await inner.members(req)),
  };
}

function snapshotJob(
  audienceId: string,
  scratch: { id: string; token: string },
  snapshotVersion: number
): MaterializeJob {
  return {
    ...campaignJob({ audienceId, campaign: scratch }),
    jobId: audienceId,
    target: { kind: 'snapshot', audienceId, snapshotVersion },
  };
}

async function snapshotIds(
  audienceId: string,
  snapshotVersion: number
): Promise<string[]> {
  const rows = await sql.$queryRawUnsafe<{ profile_id: string }[]>(
    `SELECT profile_id FROM marketing.audience_snapshot_ids
     WHERE audience_id = $1::uuid AND snapshot_version = $2 ORDER BY profile_id`,
    audienceId,
    snapshotVersion
  );
  return rows.map((row) => row.profile_id);
}

// The source goes down once the first members page is committed.
function downAfterFirstPage(job: MaterializeJob, members: FakeMember[]) {
  let down = false;
  const source = createFakeSource({ members, down: () => down });
  const failing: MaterializeJob = {
    ...job,
    saveProgress: async (tx, next, inserted) => {
      down =
        next !== 'done' && next.phase === 'members' && next.cursor !== null;
      return await job.saveProgress(tx, next, inserted);
    },
  };
  return {
    source,
    failing,
    recover: () => {
      down = false;
    },
  };
}

const idNotInSizes = (calls: { filter?: FilterTree }[]) =>
  calls.map((call) => {
    const filter = call.filter;
    if (!(filter && 'children' in filter)) {
      return 0;
    }
    const idCondition = filter.children.find(
      (child) => 'dimension' in child && child.dimension === 'id'
    );
    return idCondition && 'values' in idCondition
      ? idCondition.values.length
      : 0;
  });

describe('runMaterialization', () => {
  beforeAll(async () => {
    await migrate();
  });
  beforeEach(resetMarketingTables);

  describe('selection', () => {
    it('filter plus includes minus excludes equals the expected set', async () => {
      const audienceId = await insertAudience();
      const campaign = await insertCampaign({ audienceId });
      const matchingIncludes = range(10, 2001).map(proId);
      const otherIncludes = range(40).map(freeId);
      const excludedIncludes = otherIncludes.slice(0, 5);
      const excludedMatches = range(30, 101).map(proId);
      await addIds(audienceId, 'include', [
        ...matchingIncludes,
        ...otherIncludes,
      ]);
      await addIds(audienceId, 'exclude', [
        ...excludedIncludes,
        ...excludedMatches,
      ]);
      const source = createFakeSource({
        members: [...proMembers(), ...freeMembers(100)],
      });
      const inserted: number[] = [];

      const result = await runMaterialization(
        { sql, source },
        campaignJob({ audienceId, campaign, inserted })
      );

      const excluded = new Set([...excludedIncludes, ...excludedMatches]);
      const expected = sorted(
        [...range(MATCHING).map(proId), ...otherIncludes].filter(
          (id) => !excluded.has(id)
        )
      );
      expect(result).toEqual({ status: 'done', total: expected.length });
      const rows = await recipients(campaign.id);
      expect(rows.map((row) => row.profile_id)).toEqual(expected);
      expect(rows.every((row) => row.status === 'pending')).toBe(true);
      expect(rows.every((row) => row.project_id === PROJECT)).toBe(true);
      expect(inserted.reduce((sum, n) => sum + n, 0)).toBe(expected.length);
      expect(await stagingCount()).toBe(0);
      expect(await savedProgress(campaign.id)).toEqual({
        phase: 'done' as MaterializeProgress['phase'],
        cursor: null,
      });
    });

    it('an exclude filter removes its matches, including hand-picked ids', async () => {
      const audienceId = await insertAudience();
      const campaign = await insertCampaign({ audienceId });
      // free-000001..3 are churned, so the exclude filter beats their inclusion.
      const includes = range(5).map(freeId);
      await addIds(audienceId, 'include', includes);
      const source = createFakeSource({
        members: [...proMembers(), ...freeMembers(10)],
      });

      await runMaterialization(
        { sql, source },
        campaignJob({ audienceId, campaign, excludeFilter: CHURNED })
      );

      const expected = sorted([
        ...range(MATCHING)
          .filter((n) => n % 100 !== 0)
          .map(proId),
        freeId(4),
        freeId(5),
      ]);
      expect(await recipientIds(campaign.id)).toEqual(expected);
    });

    it('40 excludes are sent as id not_in, 1,500 are subtracted in Postgres', async () => {
      for (const excludes of [40, 1500]) {
        await resetMarketingTables();
        const audienceId = await insertAudience();
        const campaign = await insertCampaign({ audienceId });
        const excludedIds = range(excludes).map(proId);
        await addIds(audienceId, 'exclude', excludedIds);
        const source = createFakeSource({ members: proMembers() });

        await runMaterialization(
          { sql, source },
          campaignJob({ audienceId, campaign })
        );

        const memberCalls = source.calls.filter(
          (call) => call.method === 'members'
        );
        const pushed = excludes === 40 ? 40 : 0;
        expect(idNotInSizes(memberCalls)).toEqual(
          memberCalls.map(() => pushed)
        );
        const ids = await recipientIds(campaign.id);
        expect(ids).toHaveLength(MATCHING - excludes);
        expect(ids.some((id) => excludedIds.includes(id))).toBe(false);
      }
    });

    it('a hand-picked id the source does not know is still a pending recipient', async () => {
      const audienceId = await insertAudience();
      const campaign = await insertCampaign({ audienceId });
      await addIds(audienceId, 'include', ['ghost-1']);
      const source = createFakeSource({ members: proMembers(10) });

      await runMaterialization(
        { sql, source },
        campaignJob({ audienceId, campaign })
      );

      const rows = await recipients(campaign.id);
      expect(rows.find((row) => row.profile_id === 'ghost-1')?.status).toBe(
        'pending'
      );
      expect(rows).toHaveLength(11);
    });

    it('an includes-only audience pages nothing from the source', async () => {
      const audienceId = await insertAudience();
      const campaign = await insertCampaign({ audienceId });
      await addIds(audienceId, 'include', ['a', 'b']);
      await addIds(audienceId, 'exclude', ['b']);
      const source = createFakeSource({ members: proMembers(10) });

      await runMaterialization(
        { sql, source },
        campaignJob({ audienceId, campaign, filter: null })
      );

      expect(source.calls).toHaveLength(0);
      expect(await recipientIds(campaign.id)).toEqual(['a']);
    });

    it('skipPrevious writes already_received for ids sent or uncertain in an earlier campaign with the same key, and pending for ids skipped there', async () => {
      const audienceId = await insertAudience();
      const insertRows = async (
        campaignId: string,
        rows: [string, string][],
        projectId = PROJECT
      ) => {
        for (const [profileId, status] of rows) {
          await sql.$executeRawUnsafe(
            `INSERT INTO marketing.campaign_recipients (campaign_id, profile_id, project_id, status)
             VALUES ($1::uuid, $2, $3, $4)`,
            campaignId,
            profileId,
            projectId,
            status
          );
        }
      };
      const earlier = await insertCampaign({
        audienceId,
        state: 'completed',
        key: 'diwali',
      });
      await insertRows(earlier.id, [
        [proId(1), 'sent'],
        [proId(2), 'uncertain'],
        [proId(3), 'skipped'],
        [proId(4), 'failed'],
      ]);
      const otherKey = await insertCampaign({
        audienceId,
        state: 'completed',
        key: 'holi',
      });
      await insertRows(otherKey.id, [[proId(5), 'sent']]);
      const otherProject = await insertCampaign({
        audienceId,
        projectId: 'p2',
        state: 'completed',
        key: 'diwali',
      });
      await insertRows(otherProject.id, [[proId(6), 'sent']], 'p2');
      const campaign = await insertCampaign({ audienceId, key: 'diwali' });
      const source = createFakeSource({ members: proMembers(8) });

      await runMaterialization(
        { sql, source },
        campaignJob({ audienceId, campaign, key: 'diwali', skipPrevious: true })
      );

      const rows = await recipients(campaign.id);
      const byId = Object.fromEntries(
        rows.map((row) => [row.profile_id, [row.status, row.reason]])
      );
      expect(byId).toEqual({
        [proId(1)]: ['skipped', 'already_received'],
        [proId(2)]: ['skipped', 'already_received'],
        [proId(3)]: ['pending', null],
        [proId(4)]: ['pending', null],
        [proId(5)]: ['pending', null],
        [proId(6)]: ['pending', null],
        [proId(7)]: ['pending', null],
        [proId(8)]: ['pending', null],
      });
    });

    it('a campaign from a snapshot copies that version and ignores the live filter', async () => {
      const audienceId = await insertAudience();
      await sql.$executeRawUnsafe(
        `INSERT INTO marketing.audience_snapshot_ids (audience_id, snapshot_version, profile_id)
         VALUES ($1::uuid, 1, 'old'), ($1::uuid, 2, 'x'), ($1::uuid, 2, 'y')`,
        audienceId
      );
      const campaign = await insertCampaign({ audienceId });
      const source = createFakeSource({ members: proMembers(10) });
      const job = campaignJob({ audienceId, campaign });

      const result = await runMaterialization(
        { sql, source },
        {
          ...job,
          target: {
            kind: 'campaign',
            campaignId: campaign.id,
            campaignKey: null,
            skipPrevious: false,
            fromSnapshot: { audienceId, snapshotVersion: 2 },
          },
        }
      );

      expect(result).toEqual({ status: 'done', total: 2 });
      expect(source.calls).toHaveLength(0);
      expect(await recipientIds(campaign.id)).toEqual(['x', 'y']);
    });

    it('a snapshot target writes the ids at its version', async () => {
      const audienceId = await insertAudience();
      const scratch = await insertCampaign({ audienceId });
      await addIds(audienceId, 'include', ['zz-1']);
      const source = createFakeSource({ members: proMembers(5) });

      const result = await runMaterialization(
        { sql, source },
        {
          ...campaignJob({ audienceId, campaign: scratch }),
          jobId: audienceId,
          target: { kind: 'snapshot', audienceId, snapshotVersion: 3 },
        }
      );

      expect(result).toEqual({ status: 'done', total: 6 });
      const rows = await sql.$queryRawUnsafe<{ profile_id: string }[]>(
        `SELECT profile_id FROM marketing.audience_snapshot_ids
         WHERE audience_id = $1::uuid AND snapshot_version = 3 ORDER BY profile_id`,
        audienceId
      );
      expect(rows.map((row) => row.profile_id)).toEqual([
        ...range(5).map(proId),
        'zz-1',
      ]);
      expect(await recipientIds(scratch.id)).toEqual([]);
    });

    it('no table contains the fake members displayName or contact values afterwards', async () => {
      const audienceId = await insertAudience();
      const campaign = await insertCampaign({ audienceId });
      await addIds(audienceId, 'exclude', [proId(1)]);
      const fake = createFakeSource({ members: proMembers(50) });
      const fields: string[] = [];
      const source: AudienceSource = {
        ...fake,
        members: (req) => {
          fields.push(req.fields);
          return fake.members(req);
        },
      };

      await runMaterialization(
        { sql, source },
        campaignJob({ audienceId, campaign, excludeFilter: CHURNED })
      );

      const tables = await sql.$queryRawUnsafe<{ tablename: string }[]>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'marketing'`
      );
      for (const { tablename } of tables) {
        const rows = await sql.$queryRawUnsafe<{ row: string }[]>(
          `SELECT t::text AS row FROM marketing."${tablename}" t`
        );
        const text = rows.map((row) => row.row).join('\n');
        for (const secret of [DISPLAY_NAME, PHONE, EMAIL]) {
          expect(text.includes(secret)).toBe(false);
        }
      }
      expect(await recipientIds(campaign.id)).toHaveLength(49);
      expect(fields.length).toBeGreaterThan(0);
      expect(fields.every((field) => field === 'id')).toBe(true);
    });

    it('more than 1,000 staged excludes from the list and the exclude filter push nothing and are still subtracted', async () => {
      const audienceId = await insertAudience();
      const campaign = await insertCampaign({ audienceId });
      // 980 listed plus 30 churned, 9 of them listed too: 1,001 distinct.
      const listed = range(980, 2001).map(proId);
      await addIds(audienceId, 'exclude', listed);
      const source = createFakeSource({ members: proMembers() });

      await runMaterialization(
        { sql, source },
        campaignJob({ audienceId, campaign, excludeFilter: CHURNED })
      );

      expect(idNotInSizes(source.calls).every((size) => size === 0)).toBe(true);
      const excluded = new Set([
        ...listed,
        ...range(30).map((n) => proId(n * 100)),
      ]);
      expect(excluded.size).toBe(1001);
      expect(await recipientIds(campaign.id)).toEqual(
        range(MATCHING)
          .map(proId)
          .filter((id) => !excluded.has(id))
      );
    });
  });

  describe('resume and claims', () => {
    it('a crash in saveProgress after page 2 rolls that page back; a rerun from the saved progress yields the exact set with no duplicates', async () => {
      const audienceId = await insertAudience();
      const campaign = await insertCampaign({ audienceId });
      await addIds(audienceId, 'exclude', [proId(5)]);
      await addIds(audienceId, 'include', ['inc-1']);
      const source = createFakeSource({ members: proMembers() });
      const job = campaignJob({ audienceId, campaign });
      let memberSaves = 0;
      const crashing: MaterializeJob = {
        ...job,
        saveProgress: async (tx, next, inserted) => {
          const saved = await job.saveProgress(tx, next, inserted);
          if (
            next !== 'done' &&
            next.phase === 'members' &&
            next.cursor !== null
          ) {
            memberSaves += 1;
          }
          if (memberSaves === 2) {
            throw new Error('crash');
          }
          return saved;
        },
      };

      await expect(
        runMaterialization({ sql, source }, crashing)
      ).rejects.toThrow('crash');

      // pro-000005 is pushed as not_in, so page 1 reaches one id further.
      expect(await recipientIds(campaign.id)).toHaveLength(PAGE_SIZE);
      const progress = await savedProgress(campaign.id);
      expect(progress).toEqual({
        phase: 'members',
        cursor: proId(PAGE_SIZE + 1),
      });

      const result = await runMaterialization(
        { sql, source },
        { ...job, progress }
      );

      const expected = sorted([
        ...range(MATCHING)
          .filter((n) => n !== 5)
          .map(proId),
        'inc-1',
      ]);
      expect(result).toEqual({ status: 'done', total: expected.length });
      expect(await recipientIds(campaign.id)).toEqual(expected);
      expect(await stagingCount()).toBe(0);
    });

    it('a fresh run wipes staging rows left by an earlier attempt of the same job', async () => {
      const audienceId = await insertAudience();
      const campaign = await insertCampaign({ audienceId });
      await sql.$executeRawUnsafe(
        'INSERT INTO marketing.materialize_exclusions (job_id, profile_id) VALUES ($1::uuid, $2)',
        campaign.id,
        proId(1)
      );
      const source = createFakeSource({ members: proMembers(3) });

      await runMaterialization(
        { sql, source },
        campaignJob({ audienceId, campaign })
      );

      expect(await recipientIds(campaign.id)).toEqual(range(3).map(proId));
    });

    it('two runMaterialization calls on the same job at once, each with its own claim token, produce the exact set and the loser gets lost_claim', async () => {
      const audienceId = await insertAudience();
      const campaign = await insertCampaign({ audienceId });
      await addIds(audienceId, 'exclude', [proId(7)]);
      const source = createFakeSource({ members: proMembers() });
      const winner = campaignJob({ audienceId, campaign });
      const loser = campaignJob({
        audienceId,
        campaign: { id: campaign.id, token: crypto.randomUUID() },
      });

      const results = await Promise.all([
        runMaterialization({ sql, source }, winner),
        runMaterialization({ sql, source }, loser),
      ]);

      expect(results).toEqual([
        { status: 'done', total: MATCHING - 1 },
        { status: 'lost_claim' },
      ]);
      expect(await recipientIds(campaign.id)).toEqual(
        range(MATCHING)
          .filter((n) => n !== 7)
          .map(proId)
      );
    });

    it('the source going down after page 1 propagates SourceUnavailableError and leaves page 1 committed; a rerun completes', async () => {
      const audienceId = await insertAudience();
      const campaign = await insertCampaign({ audienceId });
      const job = campaignJob({ audienceId, campaign });
      const { source, failing, recover } = downAfterFirstPage(
        job,
        proMembers()
      );

      await expect(
        runMaterialization({ sql, source }, failing)
      ).rejects.toBeInstanceOf(SourceUnavailableError);
      expect(await recipientIds(campaign.id)).toHaveLength(PAGE_SIZE);

      recover();
      const result = await runMaterialization(
        { sql, source },
        { ...job, progress: await savedProgress(campaign.id) }
      );

      expect(result).toEqual({ status: 'done', total: MATCHING });
    });

    it('a crash in an exclusions page with a non-null cursor rolls that page back; a rerun resumes the exclude filter', async () => {
      const audienceId = await insertAudience();
      const campaign = await insertCampaign({ audienceId });
      const source = createFakeSource({ members: proMembers() });
      const job = campaignJob({ audienceId, campaign, excludeFilter: CHURNED });
      let exclusionSaves = 0;
      const crashing: MaterializeJob = {
        ...job,
        saveProgress: async (tx, next, inserted) => {
          const saved = await job.saveProgress(tx, next, inserted);
          if (next !== 'done' && next.phase === 'exclusions') {
            exclusionSaves += 1;
          }
          if (exclusionSaves === 2) {
            throw new Error('crash');
          }
          return saved;
        },
      };

      await expect(
        runMaterialization({ sql, source, pageSize: 10 }, crashing)
      ).rejects.toThrow('crash');
      expect(await stagingCount()).toBe(10);
      const progress = await savedProgress(campaign.id);
      expect(progress).toEqual({ phase: 'exclusions', cursor: proId(1000) });

      await runMaterialization({ sql, source }, { ...job, progress });

      expect(await recipientIds(campaign.id)).toEqual(
        range(MATCHING)
          .filter((n) => n % 100 !== 0)
          .map(proId)
      );
      expect(await stagingCount()).toBe(0);
    });

    it('a stolen claim between page 1 and page 2 rolls page 2 back and returns lost_claim', async () => {
      const audienceId = await insertAudience();
      const campaign = await insertCampaign({ audienceId });
      const fake = createFakeSource({ members: proMembers() });
      const stealing: AudienceSource = {
        ...fake,
        members: async (req) => {
          if (req.cursor) {
            await sql.$executeRawUnsafe(
              'UPDATE marketing.campaigns SET materialize_lease_token = gen_random_uuid() WHERE id = $1::uuid',
              campaign.id
            );
          }
          return await fake.members(req);
        },
      };

      const result = await runMaterialization(
        { sql, source: stealing },
        campaignJob({ audienceId, campaign })
      );

      expect(result).toEqual({ status: 'lost_claim' });
      expect(await recipientIds(campaign.id)).toEqual(
        range(PAGE_SIZE).map(proId)
      );
      expect(await savedProgress(campaign.id)).toEqual({
        phase: 'members',
        cursor: proId(PAGE_SIZE),
      });
    });

    it('a rerun with skipPrevious does not mark its own earlier rows already_received', async () => {
      const audienceId = await insertAudience();
      const campaign = await insertCampaign({ audienceId, key: 'diwali' });
      const source = createFakeSource({ members: proMembers() });
      const job = campaignJob({
        audienceId,
        campaign,
        key: 'diwali',
        skipPrevious: true,
      });
      let checks = 0;
      await runMaterialization(
        {
          sql,
          source,
          shouldStop: async () => {
            checks += 1;
            return checks === 2;
          },
        },
        job
      );

      await runMaterialization(
        { sql, source },
        { ...job, progress: await savedProgress(campaign.id) }
      );

      const rows = await recipients(campaign.id);
      expect(rows).toHaveLength(MATCHING);
      expect(rows.every((row) => row.status === 'pending')).toBe(true);
    });
    it('shouldStop true between pages returns stopped', async () => {
      const audienceId = await insertAudience();
      const campaign = await insertCampaign({ audienceId });
      const source = createFakeSource({ members: proMembers() });
      let checks = 0;

      const result = await runMaterialization(
        {
          sql,
          source,
          shouldStop: async () => {
            checks += 1;
            return checks === 2;
          },
        },
        campaignJob({ audienceId, campaign })
      );

      expect(result).toEqual({ status: 'stopped' });
      expect(await recipientIds(campaign.id)).toHaveLength(PAGE_SIZE);
      expect(await savedProgress(campaign.id)).toEqual({
        phase: 'members',
        cursor: proId(PAGE_SIZE),
      });
    });
  });

  describe('fresh restarts', () => {
    it('a snapshot restarted from null progress drops ids an earlier attempt committed that the filter no longer matches', async () => {
      const audienceId = await insertAudience();
      const scratch = await insertCampaign({ audienceId });
      const job = snapshotJob(audienceId, scratch, 4);
      const { source, failing } = downAfterFirstPage(job, proMembers());

      await expect(
        runMaterialization({ sql, source }, failing)
      ).rejects.toBeInstanceOf(SourceUnavailableError);
      expect(await snapshotIds(audienceId, 4)).toContain(proId(1));

      const changed = createFakeSource({ members: proMembers().slice(1) });
      const result = await runMaterialization({ sql, source: changed }, job);

      expect(result).toEqual({ status: 'done', total: MATCHING - 1 });
      expect(await snapshotIds(audienceId, 4)).not.toContain(proId(1));
    });

    it('a campaign restarted from null progress drops recipients an earlier attempt committed that the filter no longer matches', async () => {
      const audienceId = await insertAudience();
      const campaign = await insertCampaign({ audienceId });
      const job = campaignJob({ audienceId, campaign });
      const { source, failing } = downAfterFirstPage(job, proMembers());

      await expect(
        runMaterialization({ sql, source }, failing)
      ).rejects.toBeInstanceOf(SourceUnavailableError);
      expect(await recipientIds(campaign.id)).toContain(proId(1));

      const changed = createFakeSource({ members: proMembers().slice(1) });
      const result = await runMaterialization({ sql, source: changed }, job);

      expect(result).toEqual({ status: 'done', total: MATCHING - 1 });
      expect(await recipientIds(campaign.id)).not.toContain(proId(1));
    });

    it('a fresh restart refuses a campaign that already has a sent recipient', async () => {
      const audienceId = await insertAudience();
      const campaign = await insertCampaign({ audienceId });
      await sql.$executeRawUnsafe(
        `INSERT INTO marketing.campaign_recipients (campaign_id, profile_id, project_id, status)
         VALUES ($1::uuid, $2, $3, 'sent')`,
        campaign.id,
        proId(1),
        PROJECT
      );
      const source = createFakeSource({ members: proMembers(5) });

      await expect(
        runMaterialization(
          { sql, source },
          campaignJob({ audienceId, campaign })
        )
      ).rejects.toThrow('materialisation restart after sending began');
      expect(await recipients(campaign.id)).toEqual([
        {
          profile_id: proId(1),
          status: 'sent',
          reason: null,
          project_id: PROJECT,
        },
      ]);
    });
  });

  describe('page validation', () => {
    it('a page with an id repeated from the previous page is absorbed', async () => {
      const audienceId = await insertAudience();
      const campaign = await insertCampaign({ audienceId });
      const source = wrapMembers(
        createFakeSource({ members: proMembers() }),
        (req, page) =>
          req.cursor
            ? { ...page, members: [{ id: req.cursor }, ...page.members] }
            : page
      );

      const result = await runMaterialization(
        { sql, source },
        campaignJob({ audienceId, campaign })
      );

      expect(result).toEqual({ status: 'done', total: MATCHING });
      expect(await recipientIds(campaign.id)).toEqual(
        range(MATCHING).map(proId)
      );
    });

    it('a cursor cycle A, B, A is a SourceProtocolError', async () => {
      const audienceId = await insertAudience();
      const campaign = await insertCampaign({ audienceId });
      const pages: Record<string, { id: string; next: string }> = {
        start: { id: 'a', next: 'a' },
        a: { id: 'b', next: 'b' },
        b: { id: 'c', next: 'a' },
      };
      const cycling: AudienceSource = {
        ...createFakeSource({ members: [] }),
        members: async (req) => {
          const page = pages[req.cursor ?? 'start'] ?? { id: 'z', next: 'z' };
          return { members: [{ id: page.id }], nextCursor: page.next };
        },
      };

      const error = await runMaterialization(
        { sql, source: cycling },
        campaignJob({ audienceId, campaign })
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(SourceProtocolError);
      expect((error as Error).message).toBe('cursor_not_advancing');
    });

    it('a 257-character id and a non-advancing cursor are SourceProtocolErrors', async () => {
      const audienceId = await insertAudience();
      const campaign = await insertCampaign({ audienceId });
      const fake = createFakeSource({ members: proMembers() });
      const overlong = wrapMembers(fake, (_req, page) => ({
        ...page,
        members: [...page.members, { id: 'x'.repeat(OVERLONG_ID_LENGTH) }],
      }));
      const stuck = wrapMembers(fake, (req, page) =>
        req.cursor ? { ...page, nextCursor: req.cursor } : page
      );

      for (const source of [overlong, stuck]) {
        const error = await runMaterialization(
          { sql, source },
          campaignJob({ audienceId, campaign })
        ).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(SourceProtocolError);
      }
    });

    it('a snapshot target over MAX_SNAPSHOT_IDS fails and writes nothing at the new version', async () => {
      const audienceId = await insertAudience();
      const scratch = await insertCampaign({ audienceId });
      await sql.$executeRawUnsafe(
        `INSERT INTO marketing.audience_snapshot_ids (audience_id, snapshot_version, profile_id)
         VALUES ($1::uuid, 1, 'kept')`,
        audienceId
      );
      // Generated pages: a 100,001-member fake would re-filter every member per page.
      const total = MAX_SNAPSHOT_IDS + 1;
      const generated: AudienceSource = {
        ...createFakeSource({ members: [] }),
        members: async (req) => {
          const start = req.cursor ? Number(req.cursor.slice(1)) : 0;
          const end = Math.min(start + req.limit, total);
          const ids = range(end - start, start + 1).map(
            (n) => `s${String(n).padStart(7, '0')}`
          );
          return {
            members: ids.map((id) => ({ id })),
            nextCursor: end < total ? (ids.at(-1) ?? null) : null,
          };
        },
      };

      const error = await runMaterialization(
        { sql, source: generated },
        {
          ...campaignJob({ audienceId, campaign: scratch }),
          jobId: audienceId,
          target: { kind: 'snapshot', audienceId, snapshotVersion: 2 },
        }
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(SourceProtocolError);
      expect((error as Error).message).toBe('snapshot_too_large');
      const rows = await sql.$queryRawUnsafe<
        { snapshot_version: number; n: number }[]
      >(
        `SELECT snapshot_version, count(*)::int AS n FROM marketing.audience_snapshot_ids
         WHERE audience_id = $1::uuid GROUP BY snapshot_version`,
        audienceId
      );
      expect(rows).toEqual([{ snapshot_version: 1, n: 1 }]);
      expect(await stagingCount()).toBe(0);
    }, 120_000);
  });
});
