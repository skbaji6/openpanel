import { createHmac } from 'node:crypto';
import type { Queryable } from './engine';

// Push tokens of http-source projects come from the owner's API, so there is no device row to
// delete. A dead token is remembered only as a keyed hash, never as the token itself.
export const DEAD_TOKEN_RETENTION_DAYS = 90;
const KEY_PURPOSE = 'marketing:dead-token:v1';

export function hashToken(secretKey: string, token: string): Buffer {
  const hashKey = createHmac('sha256', secretKey).update(KEY_PURPOSE).digest();
  return createHmac('sha256', hashKey).update(token).digest();
}

function hashesOf(tokens: string[], key: string): Buffer[] {
  return [...new Set(tokens)].map((token) => hashToken(key, token));
}

export async function recordDeadTokens(
  sql: Queryable,
  projectId: string,
  tokens: string[],
  key: string
): Promise<void> {
  if (tokens.length === 0) {
    return;
  }
  await sql.$executeRawUnsafe(
    `INSERT INTO marketing.dead_tokens (project_id, token_hash)
     SELECT $1, h FROM unnest($2::bytea[]) AS h
     ON CONFLICT (project_id, token_hash) DO UPDATE SET seen_at = now()`,
    projectId,
    hashesOf(tokens, key)
  );
}

export async function filterLiveTokens(
  sql: Queryable,
  projectId: string,
  tokens: string[],
  key: string
): Promise<string[]> {
  if (tokens.length === 0) {
    return [];
  }
  const dead = await sql.$queryRawUnsafe<{ token_hash: Uint8Array }[]>(
    `SELECT token_hash FROM marketing.dead_tokens
     WHERE project_id = $1 AND token_hash = ANY($2::bytea[])`,
    projectId,
    hashesOf(tokens, key)
  );
  const deadHashes = new Set(
    dead.map((row) => Buffer.from(row.token_hash).toString('hex'))
  );
  return tokens.filter(
    (token) => !deadHashes.has(hashToken(key, token).toString('hex'))
  );
}

export function purgeDeadTokens(sql: Queryable): Promise<number> {
  return sql.$executeRawUnsafe(
    `DELETE FROM marketing.dead_tokens WHERE seen_at < now() - ($1::int * interval '1 day')`,
    DEAD_TOKEN_RETENTION_DAYS
  );
}
