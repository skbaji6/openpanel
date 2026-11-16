import { describe, expect, it } from 'bun:test';
import { gatherLookupBatch } from './lookup-batch';

const WINDOW_MS = 2000;
const MAX_BATCH = 500;

interface Item {
  projectId: string;
  profileId: string;
}

function items(projectId: string, count: number, offset = 0): Item[] {
  return Array.from({ length: count }, (_, index) => ({
    projectId,
    profileId: `p${offset + index}`,
  }));
}

function fakeClock(refills: Item[][] = []) {
  let time = 0;
  const sleeps: number[] = [];
  let refillCalls = 0;
  return {
    sleeps,
    get refillCalls() {
      return refillCalls;
    },
    opts: {
      maxBatch: MAX_BATCH,
      windowMs: WINDOW_MS,
      now: () => time,
      sleep: (ms: number) => {
        sleeps.push(ms);
        time += ms;
        return Promise.resolve();
      },
      refill: () => {
        refillCalls++;
        return Promise.resolve(refills.shift() ?? []);
      },
    },
  };
}

describe('gatherLookupBatch', () => {
  it('returns without waiting when every group is full', async () => {
    const clock = fakeClock();
    const groups = await gatherLookupBatch(items('a', 500), clock.opts);
    expect(groups.map((group) => group.length)).toEqual([500]);
    expect(clock.sleeps).toEqual([]);
    expect(clock.refillCalls).toBe(0);
  });

  it('dispatches a partial group after the window', async () => {
    const clock = fakeClock([items('a', 2, 3)]);
    const groups = await gatherLookupBatch(items('a', 3), clock.opts);
    expect(groups.map((group) => group.length)).toEqual([5]);
    expect(clock.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(WINDOW_MS);
    expect(clock.refillCalls).toBeGreaterThan(0);
  });

  it('a full group next to a partial one waits at most windowMs with it', async () => {
    const clock = fakeClock();
    const groups = await gatherLookupBatch(
      [...items('a', 500), ...items('b', 1)],
      clock.opts
    );
    expect(groups.map((group) => group.length)).toEqual([500, 1]);
    expect(clock.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(WINDOW_MS);
  });

  it('groups by project', async () => {
    const clock = fakeClock([items('b', 1, 10)]);
    const groups = await gatherLookupBatch(
      [...items('a', 2), ...items('b', 1)],
      clock.opts
    );
    const byProject = Object.fromEntries(
      groups.map((group) => [
        group[0]?.projectId,
        group.map((item) => item.profileId),
      ])
    );
    expect(byProject).toEqual({ a: ['p0', 'p1'], b: ['p0', 'p10'] });
  });

  it('never exceeds 500', async () => {
    const clock = fakeClock([items('a', 400, 700)]);
    const groups = await gatherLookupBatch(items('a', 700), clock.opts);
    expect(groups.map((group) => group.length)).toEqual([500, 500, 100]);
    expect(groups.flat()).toHaveLength(1100);
  });
});
