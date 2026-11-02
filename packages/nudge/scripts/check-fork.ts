// Fails when the branch changes an upstream file beyond the three the plugin may edit.
const BASE_COMMIT = 'f019500c';
const MODIFIABLE_PATHS = new Set([
  'apps/start/src/components/sidebar-project-menu.tsx',
  'apps/start/src/routeTree.gen.ts',
  'bun.lock',
]);

export function findForkViolations(
  changes: { status: string; path: string }[]
): string[] {
  return changes
    .filter(
      ({ status, path }) =>
        !(status === 'A' || (status === 'M' && MODIFIABLE_PATHS.has(path)))
    )
    .map(({ status, path }) => `${status} ${path}`);
}

async function git(...args: string[]) {
  const proc = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.split('\n').filter(Boolean);
}

async function main() {
  const root = (await git('rev-parse', '--show-toplevel'))[0] ?? '.';
  process.chdir(root);
  const changes = [
    ...(await git('diff', '--name-status', BASE_COMMIT)).map((line) => {
      const [status, ...paths] = line.split('\t');
      // Renames and copies list "R100 old new"; keep both paths in the report.
      return { status: (status ?? '').slice(0, 1), path: paths.join(' -> ') };
    }),
    ...(await git('ls-files', '--others', '--exclude-standard')).map(
      (path) => ({ status: 'A', path })
    ),
  ];
  const violations = findForkViolations(changes);
  if (violations.length > 0) {
    console.error(`Upstream files changed (${violations.length}):`);
    for (const violation of violations) {
      console.error(`  ${violation}`);
    }
    process.exit(1);
  }
  console.log('check-fork: ok');
}

if (import.meta.main) {
  await main();
}
