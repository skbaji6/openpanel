import { sql } from './client';

const TEST_DATABASE_SUFFIX = '_test';

// Truncates every marketing table, so it refuses any database that is not clearly a test one.
async function assertTestDatabase(): Promise<void> {
  if (process.env.MARKETING_ALLOW_RESET === '1') {
    return;
  }
  const [row] = await sql.$queryRawUnsafe<{ name: string }[]>(
    'SELECT current_database() AS name'
  );
  if (!row?.name.endsWith(TEST_DATABASE_SUFFIX)) {
    throw new Error(
      `refusing to truncate marketing tables in database "${row?.name}": its name must end in ${TEST_DATABASE_SUFFIX} (or set MARKETING_ALLOW_RESET=1)`
    );
  }
}

export async function resetMarketingTables(): Promise<void> {
  await assertTestDatabase();
  const tables = await sql.$queryRawUnsafe<{ tablename: string }[]>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'marketing' AND tablename <> 'schema_migrations'`
  );
  if (tables.length === 0) {
    return;
  }
  const list = tables.map((t) => `marketing."${t.tablename}"`).join(', ');
  await sql.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}
