import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from './client';

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'migrations');

export async function migrate(): Promise<string[]> {
  await sql.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS nudge');
  await sql.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS nudge.schema_migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`
  );
  const done = new Set(
    (
      await sql.$queryRawUnsafe<{ name: string }[]>(
        'SELECT name FROM nudge.schema_migrations'
      )
    ).map((row) => row.name)
  );
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) {
      continue;
    }
    const content = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    // shortcut: splits on ';', so migration files must not contain ';' inside strings or function bodies
    const statements = content
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);
    await sql.$transaction([
      ...statements.map((statement) => sql.$executeRawUnsafe(statement)),
      sql.$executeRawUnsafe(
        'INSERT INTO nudge.schema_migrations (name) VALUES ($1)',
        file
      ),
    ]);
    applied.push(file);
  }
  return applied;
}

if (import.meta.main) {
  const applied = await migrate();
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
  process.exit(0);
}
