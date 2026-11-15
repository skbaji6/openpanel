// Local stand-ins for everything a campaign talks to, so the dashboard can be tried without real accounts:
// the reference audience API over a demo schema (50 students) and a fake MSG91. It sends nothing real.
// Usage: packages/marketing/README.md, "Trying it locally".

import { SQL } from 'bun';
import { readFileSync } from 'node:fs';
import { parseMapping } from '../examples/audience-api-postgres/mapping';
import { createServer } from '../examples/audience-api-postgres/server';
import { MAX_BODY_BYTES } from '../src/audience/http-source';
import { startFakeMsg91 } from '../src/channels/fakes/msg91-server';

const DEFAULT_AUDIENCE_PORT = 4200;
const AUDIENCE_KEY_ID = 'dev';
// Not a secret: it only protects the demo API on this machine.
const DEFAULT_AUDIENCE_SECRET = 'dev-stack-not-a-real-secret';
const EXAMPLE_DIR = '../examples/audience-api-postgres';
const FIRST_EXTRA_STUDENT = 8;
const LAST_STUDENT = 50;
// Students 8 to 27: semester 6, a phone and SMS consent, so "Semester is 6" is a clean test audience of 20.
const LAST_SEMESTER_SIX_STUDENT = 27;
const SEMESTER_SIX = 6;
const OTHER_SEMESTER = 7;

const rawDatabaseUrl = process.env.DATABASE_URL?.trim();
if (!rawDatabaseUrl) {
  throw new Error(
    'DATABASE_URL is required: the demo audience lives in the schema reference_demo of that database'
  );
}
const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const ALLOW_REMOTE_ENV = 'DEV_STACK_ALLOW_REMOTE_DATABASE';
if (
  !(
    LOCAL_DATABASE_HOSTS.has(new URL(rawDatabaseUrl).hostname) ||
    process.env[ALLOW_REMOTE_ENV] === '1'
  )
) {
  throw new Error(
    `This script drops the schema reference_demo, and DATABASE_URL is not on this machine. Set ${ALLOW_REMOTE_ENV}=1 to use it anyway.`
  );
}
// Prisma's ?schema=public is not a Postgres setting, so Bun's driver rejects it.
const databaseUrl = new URL(rawDatabaseUrl);
databaseUrl.searchParams.delete('schema');

const audiencePort = Number(process.env.AUDIENCE_PORT ?? DEFAULT_AUDIENCE_PORT);
const audienceSecret =
  process.env.AUDIENCE_SECRET?.trim() || DEFAULT_AUDIENCE_SECRET;

const sql = new SQL(databaseUrl.toString());
await sql.unsafe(
  readFileSync(new URL(`${EXAMPLE_DIR}/seed.sql`, import.meta.url), 'utf8')
);
// Fake numbers in a reserved test range; the fake MSG91 only counts them.
await sql.unsafe(`
  INSERT INTO reference_demo.students
    (id, first_name, last_name, email, email_verified, phone, password_hash,
     university_id, course_id, semester, joined_on, withdrawn, whatsapp_consent, sms_consent)
  SELECT 's' || lpad(g::text, 3, '0'), 'Student', g::text, 's' || g || '@example.test', true,
         '9190000' || lpad(g::text, 5, '0'), 'unused', 'u1', 'c1',
         CASE WHEN g <= ${LAST_SEMESTER_SIX_STUDENT} THEN ${SEMESTER_SIX} ELSE ${OTHER_SEMESTER} END,
         '2025-09-01', false, true, true
  FROM generate_series(${FIRST_EXTRA_STUDENT}, ${LAST_STUDENT}) g`);

const mapping = parseMapping(
  JSON.parse(
    readFileSync(
      new URL(`${EXAMPLE_DIR}/mapping.example.json`, import.meta.url),
      'utf8'
    )
  )
);
const audienceApp = createServer({
  mapping,
  keys: [{ id: AUDIENCE_KEY_ID, secret: audienceSecret }],
  db: {
    async query(text, params) {
      const rows = await sql.unsafe(text, params as never[]);
      return { rows: [...rows] };
    },
  },
});
const audienceServer = Bun.serve({
  port: audiencePort,
  fetch: audienceApp.fetch,
  maxRequestBodySize: MAX_BODY_BYTES,
});

const msg91 = await startFakeMsg91();
const msg91Host = new URL(msg91.baseUrl).hostname;

console.log(`
Dev stack is running. Nothing here reaches a real provider.

Worker (start it with this variable, then restart it if it was already running):
  MARKETING_WEBHOOK_ALLOW_HOSTS=${msg91Host}

Dashboard, Marketing > Channels > Audience source (HTTP API):
  Base URL   http://localhost:${audienceServer.port}
  Key id     ${AUDIENCE_KEY_ID}
  Secret     ${audienceSecret}

Dashboard, Marketing > Channels > SMS (MSG91):
  MSG91 auth key   anything (the fake accepts any key)
  Base URL         ${msg91.baseUrl}
  (this port changes on every run; update it when you restart this script)

Audience to try: field "Semester", value 6 gives 20 students.
Browser check:   MARKETING_E2E=1 MARKETING_E2E_MSG91_URL=${msg91.baseUrl} bunx playwright test e2e/marketing-campaigns.spec.ts
Push has no local fake yet: use the SMS channel.
Press Ctrl+C to stop.
`);

let stopping = false;
async function stop() {
  if (stopping) {
    return;
  }
  stopping = true;
  await audienceServer.stop(true);
  await msg91.close();
  await sql.close();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
