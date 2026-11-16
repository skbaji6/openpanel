// Usage: bun scripts/import-journeys.ts <file> --state <sheet>=<value> ... [--project <id> --apply]
// Dry run by default (no database). Prints keys, counts and problem codes, never message text.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { readCsv } from '../src/journeys/csv-reader';
import { planImport } from '../src/journeys/import-plan';
import { readXlsx } from '../src/journeys/xlsx-reader';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    state: { type: 'string', multiple: true },
    project: { type: 'string' },
    apply: { type: 'boolean' },
  },
});

const file = positionals[0];
if (!file) {
  throw new Error('usage: import-journeys <file> --state <sheet>=<value>');
}
const states: Record<string, string> = {};
for (const pair of values.state ?? []) {
  const separator = pair.indexOf('=');
  states[pair.slice(0, separator)] = pair.slice(separator + 1);
}

const bytes = readFileSync(file);
const sheets = file.toLowerCase().endsWith('.csv')
  ? readCsv(bytes.toString('utf8'))
  : readXlsx(new Uint8Array(bytes));
const { journeys, problems } = planImport(sheets, { states });

let totalSteps = 0;
for (const journey of journeys) {
  const steps = journey.definition.steps;
  totalSteps += steps.length;
  const variantCounts = new Set(
    steps.map((step) => Object.keys(step.variants ?? {}).length)
  );
  console.log(
    `${journey.key} steps=${steps.length} variantsPerStep=${[...variantCounts].join('/')} unconfirmed=${journey.unconfirmed.join(',') || '-'}`
  );
}
console.log(`journeys=${journeys.length} steps=${totalSteps}`);
const counts = new Map<string, number>();
for (const problem of problems) {
  counts.set(problem.code, (counts.get(problem.code) ?? 0) + 1);
}
for (const [code, count] of counts) {
  console.log(`problem ${code} x${count}`);
}
for (const problem of problems) {
  console.log(
    `  ${problem.code} sheet#${sheets.findIndex((s) => s.sheet === problem.sheet)} row=${problem.row ?? '-'}`
  );
}

if (values.apply) {
  if (!values.project) {
    throw new Error('--apply needs --project');
  }
  const { sql } = await import('../src/db/client');
  const { applyImport } = await import('../src/journeys/import-store');
  const results = await applyImport(sql, values.project, journeys, {
    dryRun: false,
  });
  for (const result of results) {
    console.log(`${result.key} ${result.action}`);
  }
  await sql.$disconnect();
}
