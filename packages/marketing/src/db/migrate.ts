import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from './client';

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'migrations');
// Fixed key: replicas that boot together queue behind one another instead of applying the same file twice.
const MIGRATION_LOCK_KEY = 7_291_644_031;
const MIGRATION_TIMEOUT_MS = 300_000;

const DOLLAR_QUOTE = '$$';

// shortcut: splits on ';' outside $$ blocks, so a ';' inside a quoted string or a comment would break a file.
export function splitStatements(content: string): string[] {
  const statements: string[] = [];
  let current = '';
  for (const [index, part] of content.split(DOLLAR_QUOTE).entries()) {
    const insideQuote = index % 2 === 1;
    if (insideQuote) {
      current += `${DOLLAR_QUOTE}${part}${DOLLAR_QUOTE}`;
      continue;
    }
    const [head = '', ...rest] = part.split(';');
    current += head;
    for (const piece of rest) {
      statements.push(current);
      current = piece;
    }
  }
  statements.push(current);
  return statements.map((statement) => statement.trim()).filter(Boolean);
}

async function migrationFiles() {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  return await Promise.all(
    files.map(async (file) => ({
      file,
      content: await readFile(join(MIGRATIONS_DIR, file), 'utf8'),
    }))
  );
}

// One transaction for the whole run: the advisory lock is released only when it commits or rolls back.
export async function migrate(): Promise<string[]> {
  const migrations = await migrationFiles();
  return await sql.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`
      );
      await tx.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS marketing');
      await tx.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS marketing.schema_migrations (
           name text PRIMARY KEY,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`
      );
      const done = new Set(
        (
          await tx.$queryRawUnsafe<{ name: string }[]>(
            'SELECT name FROM marketing.schema_migrations'
          )
        ).map((row) => row.name)
      );
      const applied: string[] = [];
      for (const { file, content } of migrations) {
        if (done.has(file)) {
          continue;
        }
        for (const statement of splitStatements(content)) {
          await tx.$executeRawUnsafe(statement);
        }
        await tx.$executeRawUnsafe(
          'INSERT INTO marketing.schema_migrations (name) VALUES ($1)',
          file
        );
        applied.push(file);
      }
      return applied;
    },
    { timeout: MIGRATION_TIMEOUT_MS, maxWait: MIGRATION_TIMEOUT_MS }
  );
}

if (import.meta.main) {
  const applied = await migrate();
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
  process.exit(0);
}
