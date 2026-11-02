// Overridable so the guards' failure path can be tested without breaking the real base.
export const BASE_COMMIT = process.env.GUARD_BASE_COMMIT ?? 'f019500c';

// A guard that cannot read git must fail, never pass; only a deliberate probe may tolerate a non-zero exit.
export async function runGit(
  args: string[],
  options: { allowFailure?: boolean } = {}
) {
  const proc = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0 && !options.allowFailure) {
    throw new Error(
      `git failed: git ${args.join(' ')} (exit ${code}) ${err.trim()}`
    );
  }
  return { out, ok: code === 0 };
}

export const lines = (text: string) => text.split('\n').filter(Boolean);

export async function runGuard(main: () => Promise<void>) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
