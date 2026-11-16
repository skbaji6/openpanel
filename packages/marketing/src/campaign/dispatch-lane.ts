import { redactSecrets } from '../redact';
import type { Stoppable } from '../worker';
import { type DispatchDeps, runDispatchCycle } from './dispatch';
import { reapExpiredLeases } from './recipients';

const LOG_PREFIX = 'marketing dispatch lane:';
const SWEEP_LIMIT = 100;
// Catches a campaign whose last rows were reaped by a run that crashed before completing it.
const UNFINISHED_DONE_SQL = `SELECT c.id::text FROM marketing.campaigns c
  WHERE c.state = 'running' AND c.materialize_state = 'done'
    AND NOT EXISTS (SELECT 1 FROM marketing.campaign_recipients r
      WHERE r.campaign_id = c.id AND r.status IN ('pending', 'leased', 'sending'))
  ORDER BY c.id LIMIT ${SWEEP_LIMIT}`;

export interface DispatchLaneDeps extends DispatchDeps {
  concurrency: number;
  idleMs: number;
  secrets: string[];
}

// A failed cycle rests too, so a persistent error does not spin.
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
  deps: Pick<DispatchDeps, 'sql' | 'campaigns' | 'now'> & { secrets: string[] }
): Promise<{ released: number; uncertain: number; completed: number }> {
  const { released, uncertain, campaignIds } = await reapExpiredLeases(
    deps.sql,
    deps.now()
  );
  const unfinished =
    await deps.sql.$queryRawUnsafe<{ id: string }[]>(UNFINISHED_DONE_SQL);
  let completed = 0;
  for (const campaignId of new Set([
    ...campaignIds,
    ...unfinished.map((row) => row.id),
  ])) {
    try {
      if (await deps.campaigns.completeIfDone(campaignId)) {
        completed += 1;
      }
    } catch (error) {
      console.error(
        LOG_PREFIX,
        campaignId,
        'completing:',
        redactSecrets(error, deps.secrets)
      );
    }
  }
  return { released, uncertain, completed };
}
