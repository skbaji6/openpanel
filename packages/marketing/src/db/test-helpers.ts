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

// Faster than a full reset for suites that touch few tables; CASCADE also empties tables that reference them.
export async function truncateMarketingTables(tables: string[]): Promise<void> {
  await assertTestDatabase();
  const list = tables.map((table) => `marketing."${table}"`).join(', ');
  await sql.$executeRawUnsafe(`TRUNCATE ${list} CASCADE`);
}

export async function resetMarketingTables(): Promise<void> {
  await assertTestDatabase();
  // TRUNCATE syncs files per table, which is slow enough on a slow disk to blow the 5 s hook limit,
  // so only tables that hold rows or own a sequence (RESTART IDENTITY) are truncated.
  const tables = await sql.$queryRawUnsafe<{ tablename: string }[]>(
    `SELECT t.tablename FROM pg_tables t
     WHERE t.schemaname = 'marketing' AND t.tablename <> 'schema_migrations'
       AND (
         (xpath('/row/c/text()', query_to_xml(format('SELECT EXISTS (SELECT 1 FROM marketing.%I) AS c', t.tablename), false, true, '')))[1]::text::boolean
         OR EXISTS (
           SELECT 1 FROM pg_depend d
           JOIN pg_class seq ON seq.oid = d.objid AND seq.relkind = 'S'
           JOIN pg_class tbl ON tbl.oid = d.refobjid AND tbl.relname = t.tablename AND tbl.relnamespace = 'marketing'::regnamespace
           WHERE d.deptype IN ('a', 'i')
         )
       )`
  );
  if (tables.length === 0) {
    return;
  }
  const list = tables.map((t) => `marketing."${t.tablename}"`).join(', ');
  await sql.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}
