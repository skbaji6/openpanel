import { describe, expect, it } from 'bun:test';
import { findForkViolations } from './check-fork';
import { findRenameViolations } from './check-rename';
import { runGit } from './git';

describe('findRenameViolations', () => {
  it('flags text containing the old name', () => {
    expect(
      findRenameViolations([{ path: 'src/x.ts', text: 'NUDGE_PORT=1' }])
    ).toEqual(['src/x.ts']);
  });

  it('flags a path containing the old name', () => {
    expect(findRenameViolations([{ path: 'nudge/foo.ts', text: '' }])).toEqual([
      'nudge/foo.ts',
    ]);
  });

  it('ignores docs/superpowers and clean files', () => {
    expect(
      findRenameViolations([
        { path: 'docs/superpowers/plan.md', text: 'nudge' },
        { path: 'src/ok.ts', text: 'marketing' },
      ])
    ).toEqual([]);
  });
});

describe('findForkViolations', () => {
  it('accepts added files and the allowed modifications', () => {
    expect(
      findForkViolations([
        { status: 'A', path: 'packages/marketing/a.ts' },
        { status: 'M', path: 'bun.lock' },
      ])
    ).toEqual([]);
  });

  it('rejects other modifications, deletions and renames', () => {
    expect(
      findForkViolations([
        { status: 'M', path: 'apps/start/package.json' },
        { status: 'D', path: 'apps/api/src/x.ts' },
        { status: 'R', path: 'a -> b' },
      ])
    ).toHaveLength(3);
  });
});

describe('guards fail when git fails', () => {
  const run = async (script: string) => {
    const proc = Bun.spawn(['bun', `scripts/${script}`], {
      env: { ...process.env, GUARD_BASE_COMMIT: 'not-a-real-ref' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [err, code] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { err, code };
  };

  it('runGit throws on a non-zero exit', async () => {
    await expect(
      runGit(['diff', '--name-only', 'not-a-real-ref'])
    ).rejects.toThrow('git failed');
  });

  it('runGit tolerates a non-zero exit only when asked', async () => {
    const result = await runGit(['cat-file', '-e', 'not-a-real-ref:x'], {
      allowFailure: true,
    });
    expect(result.ok).toBe(false);
  });

  for (const script of ['check-fork.ts', 'check-rename.ts']) {
    it(`${script} exits 1 and reports git failed on an unreachable base`, async () => {
      const { err, code } = await run(script);
      expect(code).toBe(1);
      expect(err).toContain('git failed');
    });
  }
});
