import { sql } from './client';

export async function resetNudgeTables(): Promise<void> {
  const tables = await sql.$queryRawUnsafe<{ tablename: string }[]>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'nudge' AND tablename <> 'schema_migrations'`
  );
  if (tables.length === 0) {
    return;
  }
  const list = tables.map((t) => `nudge."${t.tablename}"`).join(', ');
  await sql.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}
