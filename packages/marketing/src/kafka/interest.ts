import type { Redis } from '@openpanel/redis';
import type { createEngine, Queryable } from '../engine/engine';

export const INTEREST_PROFILES_KEY = 'nudge:interest:profiles';
const REDIS_ZADD_CHUNK = 1000;
const MICROSECONDS_PER_MS = 1000;

export interface ProfileKey {
  projectId: string;
  profileId: string;
}

export interface InterestQuery extends ProfileKey {
  name: string;
}

export interface InterestSet {
  has(projectId: string, name: string, profileId: string): Promise<boolean>;
  hasMany(queries: InterestQuery[]): Promise<boolean[]>;
  refresh(): Promise<void>;
  // Marks profiles active right away so other replicas keep their activity events before the next refresh.
  add(keys: ProfileKey[]): Promise<void>;
}

interface InterestDeps {
  engine: Pick<ReturnType<typeof createEngine>, 'interestNames'>;
  sql: Pick<Queryable, '$queryRawUnsafe'>;
}

// Members carry the time they were added; a refresh keeps everything added at or after its start.
interface ProfileStore {
  now(): Promise<number>;
  hasMany(members: string[]): Promise<boolean[]>;
  add(members: string[]): Promise<void>;
  reconcile(activeMembers: string[], refreshStart: number): Promise<void>;
}

// Walks the partial index enrollments_active_uniq, never the completed rows.
const ACTIVE_PROFILES_SQL = `
  SELECT DISTINCT project_id, profile_id FROM nudge.enrollments WHERE status = 'active'`;

// Activity for an inactivity goal can reach a replica before the trigger does (other partition),
// so these projects keep every identified event instead of guessing which profiles matter.
const INACTIVITY_PROJECTS_SQL = `
  SELECT DISTINCT project_id FROM nudge.rules
  WHERE status = 'active' AND definition->'goal'->>'kind' = 'inactivity'`;

// Uses the Redis clock so adds from every replica and the refresh cutoff share one clock.
const ZADD_NOW_SCRIPT = `
  local time = redis.call('TIME')
  local score = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
  for _, member in ipairs(ARGV) do redis.call('ZADD', KEYS[1], score, member) end
  return score`;

// Project ids are cuids/uuids, so a NUL separator cannot occur in either half.
function member(projectId: string, profileId: string): string {
  return `${projectId}\u0000${profileId}`;
}

function createInterestSet(
  deps: InterestDeps,
  profiles: ProfileStore
): InterestSet {
  // shortcut: names are global across projects, so a rule event in one project lets the same name through for all; key by project if that costs real throughput.
  let names = new Set<string>();
  let keepAllProjects = new Set<string>();

  async function hasMany(queries: InterestQuery[]): Promise<boolean[]> {
    const result = queries.map(
      (query) => keepAllProjects.has(query.projectId) || names.has(query.name)
    );
    const unresolved = queries.filter((_query, index) => !result[index]);
    if (unresolved.length === 0) {
      return result;
    }
    const enrolled = await profiles.hasMany(
      unresolved.map((query) => member(query.projectId, query.profileId))
    );
    let next = 0;
    return result.map((known) => known || (enrolled[next++] ?? true));
  }

  return {
    hasMany,
    async has(projectId, name, profileId) {
      const [kept] = await hasMany([{ projectId, name, profileId }]);
      return kept ?? true;
    },
    async refresh() {
      const refreshStart = await profiles.now();
      const [nextNames, rows, inactivityProjects] = await Promise.all([
        deps.engine.interestNames(),
        deps.sql.$queryRawUnsafe<{ project_id: string; profile_id: string }[]>(
          ACTIVE_PROFILES_SQL
        ),
        deps.sql.$queryRawUnsafe<{ project_id: string }[]>(
          INACTIVITY_PROJECTS_SQL
        ),
      ]);
      await profiles.reconcile(
        rows.map((row) => member(row.project_id, row.profile_id)),
        refreshStart
      );
      names = nextNames;
      keepAllProjects = new Set(
        inactivityProjects.map((row) => row.project_id)
      );
    },
    add: (keys) =>
      profiles.add(keys.map((key) => member(key.projectId, key.profileId))),
  };
}

export function createMemoryInterestSet(deps: InterestDeps): InterestSet {
  const addedAt = new Map<string, number>();
  return createInterestSet(deps, {
    now: () => Promise.resolve(Date.now()),
    hasMany: (members) =>
      Promise.resolve(members.map((value) => addedAt.has(value))),
    add: (members) => {
      const now = Date.now();
      for (const value of members) {
        addedAt.set(value, now);
      }
      return Promise.resolve();
    },
    reconcile: (activeMembers, refreshStart) => {
      for (const value of activeMembers) {
        addedAt.set(value, Math.max(addedAt.get(value) ?? 0, refreshStart));
      }
      for (const [value, time] of addedAt) {
        if (time < refreshStart) {
          addedAt.delete(value);
        }
      }
      return Promise.resolve();
    },
  });
}

export function createRedisInterestSet(
  redis: Redis,
  deps: InterestDeps
): InterestSet {
  return createInterestSet(deps, {
    async now() {
      const [seconds, microseconds] = await redis.time();
      return (
        Number(seconds) * 1000 +
        Math.floor(Number(microseconds) / MICROSECONDS_PER_MS)
      );
    },
    async hasMany(members) {
      // Fail open: letting an event through costs a Postgres write, dropping it can send a wrong nudge.
      try {
        const pipeline = redis.pipeline();
        for (const value of members) {
          pipeline.zscore(INTEREST_PROFILES_KEY, value);
        }
        const replies = (await pipeline.exec()) ?? [];
        return members.map((_value, index) => {
          const [error, score] = replies[index] ?? [new Error('no reply')];
          return error !== null || score !== null;
        });
      } catch {
        return members.map(() => true);
      }
    },
    async add(members) {
      if (members.length > 0) {
        await redis.eval(ZADD_NOW_SCRIPT, 1, INTEREST_PROFILES_KEY, ...members);
      }
    },
    async reconcile(activeMembers, refreshStart) {
      for (
        let start = 0;
        start < activeMembers.length;
        start += REDIS_ZADD_CHUNK
      ) {
        const chunk = activeMembers.slice(start, start + REDIS_ZADD_CHUNK);
        // GT keeps a newer add's score, so the prune below cannot touch it.
        await redis.zadd(
          INTEREST_PROFILES_KEY,
          'GT',
          ...chunk.flatMap((value) => [refreshStart, value])
        );
      }
      await redis.zremrangebyscore(
        INTEREST_PROFILES_KEY,
        '-inf',
        `(${refreshStart}`
      );
    },
  });
}
