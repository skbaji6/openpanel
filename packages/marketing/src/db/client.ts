import { db, PrismaClient } from '@openpanel/db';

// shortcut: a plain client, without the shared client's $extends computed fields; marketing only runs raw SQL.
export function createSql(url: string) {
  return new PrismaClient({ datasourceUrl: url }) as unknown as typeof db;
}

const dedicatedUrl = process.env.MARKETING_DATABASE_URL?.trim();

// The shared client unless the plugin has its own database.
export const sql =
  dedicatedUrl && dedicatedUrl !== process.env.DATABASE_URL
    ? createSql(dedicatedUrl)
    : db;
