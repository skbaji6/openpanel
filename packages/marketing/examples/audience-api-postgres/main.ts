import { SQL } from 'bun';
import { readFileSync } from 'node:fs';
import { MAX_BODY_BYTES } from '../../src/audience/http-source';
import { parseMapping } from './mapping';
import { createServer } from './server';

const DEFAULT_PORT = 4200;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

// AUDIENCE_KEYS="id1:secret1,id2:secret2" (two keys let you rotate without downtime).
function parseKeys(raw: string) {
  return raw.split(',').map((pair) => {
    const [id, ...rest] = pair.split(':');
    return { id: id ?? '', secret: rest.join(':') };
  });
}

const sql = new SQL(requireEnv('AUDIENCE_DATABASE_URL'));
const mapping = parseMapping(
  JSON.parse(
    readFileSync(
      process.env.AUDIENCE_MAPPING ??
        new URL('mapping.example.json', import.meta.url),
      'utf8'
    )
  )
);

const app = createServer({
  mapping,
  keys: parseKeys(requireEnv('AUDIENCE_KEYS')),
  basePath: process.env.AUDIENCE_BASE_PATH ?? '',
  db: {
    async query(text, params) {
      const rows = await sql.unsafe(text, params as never[]);
      return { rows: [...rows] };
    },
  },
});

Bun.serve({
  port: Number(process.env.AUDIENCE_PORT ?? DEFAULT_PORT),
  fetch: app.fetch,
  maxRequestBodySize: MAX_BODY_BYTES,
});
