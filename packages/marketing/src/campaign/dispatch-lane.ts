import { redactSecrets } from '../redact';
import type { Stoppable } from '../worker';
import { type DispatchDeps, runDispatchCycle } from './dispatch';
import { reapExpiredLeases } from './recipients';

const LOG_PREFIX = 'marketing dispatch lane:';

export interface DispatchLaneDeps extends DispatchDeps {
  concurrency: number;
  idleMs: number;
  secrets: string[];
}

// Each loop runs the next cycle at once while there is work and rests idleMs otherwise; a failed cycle rests too,
// so a persistent error does not spin. Stop wakes resting loops and waits for in-flight cycles to finish their marks.
export function startDispatchLane(deps: DispatchLaneDeps): Stoppable {
  let stopped = false;
  const wakers = new Set<() => void>();
  const rest = () =>
    new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        wakers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, deps.idleMs);
      wakers.add(wake);
    });

  async function loop() {
    while (!stopped) {
      let claimed = 0;
      try {
        ({ claimed } = await runDispatchCycle(deps));
      } catch (error) {
        console.error(LOG_PREFIX, redactSecrets(error, deps.secrets));
      }
      if (claimed === 0 && !stopped) {
        await rest();
      }
    }
  }

  const loops = Array.from({ length: deps.concurrency }, () => loop());
  return {
    async stop() {
      stopped = true;
      for (const wake of [...wakers]) {
        wake();
      }
      await Promise.all(loops);
    },
  };
}

// A campaign whose last rows the reaper ends has no due row left, so the dispatcher never picks it to complete it.
export async function runReapTick(
  deps: Pick<DispatchDeps, 'sql' | 'campaigns' | 'now'>
): Promise<{ released: number; uncertain: number; completed: number }> {
  const { released, uncertain, campaignIds } = await reapExpiredLeases(
    deps.sql,
    deps.now()
  );
  let completed = 0;
  for (const campaignId of campaignIds) {
    if (await deps.campaigns.completeIfDone(campaignId)) {
      completed += 1;
    }
  }
  return { released, uncertain, completed };
}
