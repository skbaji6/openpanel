import { appendFileSync } from 'node:fs';
import semver from 'semver';
import { gitOrNull, lines } from './git';

// This fork ships upstream's release plus its own build number: upstream v3.30.0
// becomes 3.30.0.1, 3.30.0.2, ... The build number never restarts: after 3.30.0.12 a merged upstream 3.31.0 builds as 3.31.0.13.
const UPSTREAM_TAG = /^v(\d+\.\d+\.\d+)$/;
const FORK_TAG = /^v(\d+\.\d+\.\d+)\.(\d+)$/;

export const baseVersion = (mergedTags: string[]): string | null =>
  mergedTags
    .map((tag) => UPSTREAM_TAG.exec(tag)?.[1])
    .filter((version): version is string => version !== undefined)
    .sort(semver.rcompare)[0] ?? null;

export const nextForkVersion = (base: string, allTags: string[]): string => {
  const builds = allTags
    .map((tag) => FORK_TAG.exec(tag))
    .map((match) => Number(match?.[2] ?? 0));
  return `${base}.${Math.max(0, ...builds) + 1}`;
};

const forkTagsAt = (args: string[]) =>
  lines(gitOrNull('tag', ...args, '--list', 'v[0-9]*.[0-9]*.[0-9]*.[0-9]*'));

type Decision =
  | { kind: 'existing' | 'new'; version: string }
  | { kind: 'superseded'; by: string };

export const decide = (sha: string): Decision => {
  const existing = forkTagsAt(['--points-at', sha])[0];
  if (existing) {
    return { kind: 'existing', version: existing.slice(1) };
  }
  // A later build already released: this run finished late and must not take a higher number.
  const newer = forkTagsAt(['--contains', sha])[0];
  if (newer) {
    return { kind: 'superseded', by: newer };
  }
  const base = baseVersion(
    lines(gitOrNull('tag', '--merged', sha, '--list', 'v[0-9]*'))
  );
  if (!base) {
    throw new Error(
      `no upstream vX.Y.Z tag is merged into ${sha}; merge one and push the tag first`
    );
  }
  const allTags = lines(gitOrNull('tag', '--list', 'v[0-9]*'));
  return { kind: 'new', version: nextForkVersion(base, allTags) };
};

const writeOutputs = (outputs: Record<string, string>) => {
  const text = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}\n`)
    .join('');
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, text);
  }
  process.stdout.write(text);
};

if (import.meta.main) {
  const sha = process.argv[2] ?? 'HEAD';
  const decision = decide(sha);
  if (decision.kind === 'superseded') {
    console.error(
      `${sha} is older than the released ${decision.by}; not tagging it.`
    );
    writeOutputs({ skip: 'true' });
  } else {
    const { major, minor } = semver.parse(
      decision.version.split('.').slice(0, 3).join('.')
    ) as semver.SemVer;
    writeOutputs({
      skip: 'false',
      is_new: String(decision.kind === 'new'),
      version: decision.version,
      minor: `${major}.${minor}`,
      major: String(major),
    });
  }
}
