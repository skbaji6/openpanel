import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { createSql, sql } from './client';

const CREATE_DATABASE_TIMEOUT_MS = 30_000;
const SECOND_DATABASE = 'openpanel_second_test';

function urlForDatabase(name: string) {
  const url = new URL(process.env.DATABASE_URL as string);
  url.pathname = `/${name}`;
  return url.toString();
}

const currentDatabase = async (client: typeof sql) =>
  (
    await client.$queryRawUnsafe<{ name: string }[]>(
      'SELECT current_database() AS name'
    )
  )[0]?.name;

describe('createSql', () => {
  const second = createSql(urlForDatabase(SECOND_DATABASE));

  beforeAll(async () => {
    const existing = await sql.$queryRawUnsafe<unknown[]>(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      SECOND_DATABASE
    );
    if (existing.length === 0) {
      await sql.$executeRawUnsafe(`CREATE DATABASE ${SECOND_DATABASE}`);
    }
  }, CREATE_DATABASE_TIMEOUT_MS);

  afterAll(async () => {
    await second.$disconnect();
  });

  it('loads and queries with only MARKETING_DATABASE_URL set', async () => {
    const { DATABASE_URL: _omitted, ...env } = process.env;
    const proc = Bun.spawn(
      [
        'bun',
        '-e',
        "const { sql } = await import('./src/db/client'); console.log(JSON.stringify(await sql.$queryRawUnsafe('SELECT 1 AS one'))); process.exit(0)",
      ],
      {
        cwd: join(import.meta.dir, '..', '..'),
        env: {
          ...env,
          MARKETING_DATABASE_URL: urlForDatabase(SECOND_DATABASE),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(err).not.toContain('Error');
    expect(out).toContain('"one":1');
  });

  it('binds the client to the given database', async () => {
    expect(await currentDatabase(second)).toBe(SECOND_DATABASE);
  });
});
