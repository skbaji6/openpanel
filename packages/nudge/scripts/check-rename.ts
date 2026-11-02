// Fails when the old plugin name survives in a file this branch added or modified.
import { readFileSync } from 'node:fs';

const BASE_COMMIT = 'f019500c';
const OLD_NAME = /nudge/i;
const SKIPPED_PATHS = [/^docs\/superpowers\//, /scripts\/check-/];
// Upstream files that the plugin legitimately edits, so they are scanned despite existing at base.
const SCANNED_UPSTREAM_PATHS = new Set([
  'apps/start/src/components/sidebar-project-menu.tsx',
  'apps/start/src/routeTree.gen.ts',
  'bun.lock',
]);

export function findRenameViolations(
  files: { path: string; text: string }[]
): string[] {
  return files
    .filter(
      ({ path, text }) =>
        !SKIPPED_PATHS.some((skipped) => skipped.test(path)) &&
        (OLD_NAME.test(path) || OLD_NAME.test(text))
    )
    .map(({ path }) => path);
}

async function git(...args: string[]) {
  const proc = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return { out, ok: code === 0 };
}

const lines = (text: string) => text.split('\n').filter(Boolean);

async function main() {
  const root = (await git('rev-parse', '--show-toplevel')).out.trim();
  process.chdir(root);
  const changed = [
    ...lines((await git('diff', '--name-only', BASE_COMMIT)).out),
    ...lines((await git('ls-files', '--others', '--exclude-standard')).out),
  ];
  const files: { path: string; text: string }[] = [];
  for (const path of new Set(changed)) {
    const existedAtBase = (
      await git('cat-file', '-e', `${BASE_COMMIT}:${path}`)
    ).ok;
    if (existedAtBase && !SCANNED_UPSTREAM_PATHS.has(path)) {
      continue;
    }
    try {
      files.push({ path, text: readFileSync(path, 'utf8') });
    } catch {
      // deleted on this branch
    }
  }
  const violations = findRenameViolations(files);
  if (violations.length > 0) {
    console.error(`Old plugin name found in ${violations.length} file(s):`);
    for (const path of violations) {
      console.error(`  ${path}`);
    }
    process.exit(1);
  }
  console.log('check-rename: ok');
}

if (import.meta.main) {
  await main();
}
