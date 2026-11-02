import { describe, expect, it } from 'bun:test';
import { findForkViolations } from './check-fork';
import { findRenameViolations } from './check-rename';

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
