import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SQL } from 'bun';
import { readFileSync } from 'node:fs';
import expected from '../../conformance/seed/expected.json';
import referenceMapping from '../../conformance/seed/reference-mapping.json';
import { parseMapping } from '../../examples/audience-api-postgres/mapping';
import { createServer } from '../../examples/audience-api-postgres/server';
import { createBreaker } from './breaker';
import { countAudience, previewAudience } from './builder';
import type { FilterTree } from './contract';
import { createHttpSource } from './http-source';
import type { createSourceLimiter } from './limiter';

const KEY = { id: 'builder-reference', secret: 'builder-reference-secret' };
const BASE_PATH = '/internal/audience';
const NOW = new Date('2026-01-01T00:00:00.000Z');
const CHECKED_FILTERS = ['course_in_multi', 'and_or_nested'];

const databaseUrl = (process.env.DATABASE_URL ?? '').split('?')[0] ?? '';
const sql = new SQL(databaseUrl);
const reference = createServer({
  mapping: parseMapping(referenceMapping),
  keys: [KEY],
  basePath: BASE_PATH,
  db: {
    async query(text, params) {
      return { rows: [...(await sql.unsafe(text, params as never[]))] };
    },
  },
});

const limiter = {
  acquire: async () => async () => undefined,
} as unknown as ReturnType<typeof createSourceLimiter>;

let server: ReturnType<typeof Bun.serve>;

function httpSource() {
  return createHttpSource({
    baseUrl: `http://127.0.0.1:${server.port}${BASE_PATH}`,
    keyId: KEY.id,
    secret: KEY.secret,
    limiter,
    breaker: createBreaker({ failureThreshold: 100, openMs: 1000 }),
  });
}

beforeAll(async () => {
  await sql.unsafe(
    readFileSync(
      new URL('../../conformance/seed/seed.sql', import.meta.url),
      'utf8'
    )
  );
  server = Bun.serve({ port: 0, fetch: reference.fetch });
});

afterAll(async () => {
  server?.stop(true);
  await sql.unsafe('DROP SCHEMA IF EXISTS conformance_demo CASCADE');
  await sql.close();
});

const definition = (filter: FilterTree) => ({
  filter,
  excludeFilter: null,
  includeCount: 0,
  excludeIds: null,
  excludeCount: 0,
});

describe('audience builder against the reference service', () => {
  for (const name of CHECKED_FILTERS) {
    it(`count and preview walk agree with expected.json for ${name}`, async () => {
      const wantCount = expected.counts.find((c) => c.name === name);
      const wantPages = expected.pages.find((p) => p.name === name);
      if (!(wantCount && wantPages)) {
        throw new Error(`expected.json has no ${name}`);
      }
      const filter = wantCount.filter as FilterTree;
      const source = httpSource();

      const counted = await countAudience(
        source,
        definition(filter),
        () => NOW
      );
      expect(counted.count).toBe(wantCount.count);
      expect(counted.approximate).toBe(false);

      const walked: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await previewAudience(
          source,
          definition(filter),
          cursor,
          wantPages.limit
        );
        walked.push(...page.members.map((m) => m.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(walked).toEqual(wantPages.pages.flat());
    });
  }
});
