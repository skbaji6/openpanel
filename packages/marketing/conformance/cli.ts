// bun conformance/cli.ts --base-url <url> --key-id <id> [--secret <secret>]
// Prefer MARKETING_CONFORMANCE_SECRET over --secret: arguments end up in shell history and process lists.
import { parseArgs } from 'node:util';
import { runConformance } from './run';

const { values } = parseArgs({
  options: {
    'base-url': { type: 'string' },
    'key-id': { type: 'string' },
    secret: { type: 'string' },
  },
});

const baseUrl = values['base-url'];
const keyId = values['key-id'];
const secret = values.secret ?? process.env.MARKETING_CONFORMANCE_SECRET;

if (!(baseUrl && keyId && secret)) {
  console.error(
    'usage: bun conformance/cli.ts --base-url <url> --key-id <id> [--secret <secret>]\n' +
      '       the secret may instead come from MARKETING_CONFORMANCE_SECRET'
  );
  process.exit(2);
}

const result = await runConformance({ baseUrl, keyId, secret });
const total = result.passed + result.failed.length;
console.log(`Audience API conformance against ${new URL(baseUrl).origin}`);
for (const { check, detail } of result.failed) {
  console.log(`  FAIL ${check}: ${detail}`);
}
for (const { check, detail } of result.warnings) {
  console.log(`  WARN ${check}: ${detail}`);
}
console.log(
  `${result.passed}/${total} checks passed, ${result.failed.length} failed, ${result.warnings.length} warnings`
);
process.exit(result.failed.length > 0 ? 1 : 0);
