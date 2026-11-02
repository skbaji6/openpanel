// How often the wait for a fuller batch checks for newly due steps.
const REFILL_INTERVAL_MS = 250;

interface GatherOptions<T> {
  maxBatch: number;
  windowMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  refill: () => Promise<T[]>;
}

// Groups per project, at most maxBatch each; returns once no group is partial or the window has closed.
export async function gatherLookupBatch<
  T extends { projectId: string; profileId: string },
>(items: T[], opts: GatherOptions<T>): Promise<T[][]> {
  const full: T[][] = [];
  const open = new Map<string, T[]>();
  const add = (batch: T[]) => {
    for (const item of batch) {
      const group = open.get(item.projectId) ?? [];
      group.push(item);
      if (group.length >= opts.maxBatch) {
        full.push(group);
        open.delete(item.projectId);
      } else {
        open.set(item.projectId, group);
      }
    }
  };
  add(items);
  const deadline = opts.now() + opts.windowMs;
  while (open.size > 0) {
    const remaining = deadline - opts.now();
    if (remaining <= 0) {
      break;
    }
    await opts.sleep(Math.min(REFILL_INTERVAL_MS, remaining));
    add(await opts.refill());
  }
  return [...full, ...open.values()];
}
