import type { Redis } from '@openpanel/redis';
import type { createEngine, Queryable } from '../engine/engine';

export const INTEREST_PROFILES_KEY = 'nudge:interest:profiles';
const REDIS_SADD_CHUNK = 1000;

export interface ProfileKey {
  projectId: string;
  profileId: string;
}

export interface InterestSet {
  has(projectId: string, name: string, profileId: string): Promise<boolean>;
  refresh(): Promise<void>;
  // Marks profiles active right away so other replicas keep their activity events before the next refresh.
  add(keys: ProfileKey[]): Promise<void>;
}

interface InterestDeps {
  engine: Pick<ReturnType<typeof createEngine>, 'interestNames'>;
  sql: Pick<Queryable, '$queryRawUnsafe'>;
}

interface ProfileStore {
  has(member: string): Promise<boolean>;
  add(members: string[]): Promise<void>;
  replace(members: string[]): Promise<void>;
}

// Walks the partial index enrollments_active_uniq, never the completed rows.
const ACTIVE_PROFILES_SQL = `
  SELECT DISTINCT project_id, profile_id FROM nudge.enrollments WHERE status = 'active'`;

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
  return {
    async has(projectId, name, profileId) {
      return (
        names.has(name) || (await profiles.has(member(projectId, profileId)))
      );
    },
    async refresh() {
      const [nextNames, rows] = await Promise.all([
        deps.engine.interestNames(),
        deps.sql.$queryRawUnsafe<{ project_id: string; profile_id: string }[]>(
          ACTIVE_PROFILES_SQL
        ),
      ]);
      await profiles.replace(
        rows.map((row) => member(row.project_id, row.profile_id))
      );
      names = nextNames;
    },
    add: (keys) =>
      profiles.add(keys.map((key) => member(key.projectId, key.profileId))),
  };
}

export function createMemoryInterestSet(deps: InterestDeps): InterestSet {
  let members = new Set<string>();
  return createInterestSet(deps, {
    has: (value) => Promise.resolve(members.has(value)),
    add: (values) => {
      for (const value of values) {
        members.add(value);
      }
      return Promise.resolve();
    },
    replace: (values) => {
      members = new Set(values);
      return Promise.resolve();
    },
  });
}

export function createRedisInterestSet(
  redis: Redis,
  deps: InterestDeps
): InterestSet {
  return createInterestSet(deps, {
    async has(value) {
      try {
        return (await redis.sismember(INTEREST_PROFILES_KEY, value)) === 1;
      } catch {
        // Fail open: letting the event through costs a Postgres write, dropping it can send a wrong nudge.
        return true;
      }
    },
    async add(values) {
      if (values.length > 0) {
        await redis.sadd(INTEREST_PROFILES_KEY, ...values);
      }
    },
    // shortcut: a profile added by another replica between this refresh's SELECT and its RENAME is dropped until the next refresh; merge instead of replace if that window matters.
    async replace(values) {
      const staging = `${INTEREST_PROFILES_KEY}:staging:${crypto.randomUUID()}`;
      for (let start = 0; start < values.length; start += REDIS_SADD_CHUNK) {
        await redis.sadd(
          staging,
          ...values.slice(start, start + REDIS_SADD_CHUNK)
        );
      }
      if (values.length === 0) {
        await redis.del(INTEREST_PROFILES_KEY);
        return;
      }
      await redis.rename(staging, INTEREST_PROFILES_KEY);
    },
  });
}
