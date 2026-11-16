import { describe, expect, test } from 'bun:test';
import { baseVersion, nextForkVersion } from './fork-version';

describe('baseVersion', () => {
  test('takes the highest upstream tag and ignores the fork build tags', () => {
    expect(baseVersion(['v3.9.1', 'v3.30.0', 'v3.30.0.7', 'v2.3.0'])).toBe(
      '3.30.0'
    );
  });

  test('is null when no upstream tag is merged', () => {
    expect(baseVersion(['v3.30.0.1', 'dashboard'])).toBeNull();
  });
});

describe('nextForkVersion', () => {
  test('the first build of an upstream version is .1', () => {
    expect(nextForkVersion('3.30.0', ['v3.30.0', 'v3.29.0.9'])).toBe(
      '3.30.0.1'
    );
  });

  test('continues the build number of the same upstream version', () => {
    expect(
      nextForkVersion('3.30.0', ['v3.30.0', 'v3.30.0.2', 'v3.30.0.11'])
    ).toBe('3.30.0.12');
  });

  test('restarts at .1 for a newer upstream version', () => {
    expect(nextForkVersion('3.31.0', ['v3.30.0.12', 'v3.31.0'])).toBe(
      '3.31.0.1'
    );
  });
});
