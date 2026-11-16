import type { Redis } from '@openpanel/redis';
import { createSourceLimiter } from './limiter';
import type { AudienceSource } from './source';

// Renewed while a call runs, so a call may outlast it; it only bounds how long a crashed holder blocks the lane.
const LANE_SLOT_TTL_MS = 30_000;
const METHODS = [
  'schema',
  'dimensionValues',
  'count',
  'members',
  'explain',
  'lookup',
  'resolve',
] as const satisfies readonly (keyof AudienceSource)[];

// Needs sourceConcurrency >= 2: at 1 the lane cap is 1 too, so a campaign call can hold the only shared slot (accepted).
// Leaves one shared source slot that campaign work can never take, so a journey lookup always finds one free.
export const campaignLaneCap = (sourceConcurrency: number) =>
  Math.max(1, sourceConcurrency - 1);

interface LaneOptions {
  redis: Redis;
  projectId: string;
  sourceConcurrency: number;
  now?: () => number;
  maxWaitMs?: number;
}

export function withCampaignLane(
  source: AudienceSource,
  options: LaneOptions
): AudienceSource {
  const limiter = createSourceLimiter(options.redis, {
    key: `${options.projectId}:campaign-lane`,
    cap: campaignLaneCap(options.sourceConcurrency),
    slotTtlMs: LANE_SLOT_TTL_MS,
    now: options.now,
    maxWaitMs: options.maxWaitMs,
  });
  const lane = {} as Record<string, unknown>;
  for (const method of METHODS) {
    lane[method] = async (...args: unknown[]) => {
      return limiter.withSlot(() =>
        (source[method] as (...inner: unknown[]) => Promise<unknown>)(...args)
      );
    };
  }
  return lane as unknown as AudienceSource;
}
