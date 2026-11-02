import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createSql, sql } from './client';

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
  });

  afterAll(async () => {
    await second.$disconnect();
  });

  it('binds the client to the given database', async () => {
    expect(await currentDatabase(second)).toBe(SECOND_DATABASE);
  });
});
