import { createHash } from 'node:crypto';
import { MAX_LOOKUP_IDS } from '../audience/contract';
import type { SourceResolver } from '../audience/resolver';
import type { Queryable } from '../engine/engine';
import { applyDeliveryUpdates, type DeliveryUpdate } from './delivery';
import type { ParsedReport } from './msg91-reports';

export const HOLD_MS = 120_000;
export const HOLD_RETRY_MS = 10_000;
export const MAX_HELD_REPORTS = 10_000;
const DEFAULT_TTL_MS = 15 * 60_000;
const DEFAULT_MAX_REQUESTS = 2000;
const PHONE_KEY_DIGITS = 10;
const NON_DIGITS = /\D/g;
const MSG91_CHANNELS = ['sms', 'whatsapp'] as const;

interface TrackedRow {
  source_ref: string;
  profile_id: string;
  channel: string | null;
}

interface Held {
  projectId: string;
  heldAt: number;
  report: ParsedReport;
}

type PhoneMap = Map<string, string>;

// sha256 of the last 10 digits, kept in process memory only and never written anywhere.
// shortcut: two recipients of one batch with the same last 10 digits are indistinguishable;
// upgrade to the channel's country-code normalisation if non-Indian numbers are sent.
function phoneKey(digits: string): string | null {
  return digits.length < PHONE_KEY_DIGITS
    ? null
    : createHash('sha256')
        .update(digits.slice(-PHONE_KEY_DIGITS))
        .digest('hex');
}

function groupByRequest<T extends { requestId: string }>(items: T[]) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.requestId);
    if (group) {
      group.push(item);
    } else {
      groups.set(item.requestId, [item]);
    }
  }
  return groups;
}

function toUpdates(map: PhoneMap, reports: ParsedReport[]) {
  const updates: DeliveryUpdate[] = [];
  let unmatched = 0;
  for (const report of reports) {
    const key = phoneKey(report.number);
    const sourceRef = key ? map.get(key) : undefined;
    if (sourceRef) {
      updates.push({
        sourceRef,
        status: report.status,
        at: report.at,
        reason: report.reason,
      });
    } else {
      unmatched++;
    }
  }
  return { updates, unmatched };
}

export interface ReportMatcherDeps {
  sql: Queryable;
  sources: Pick<SourceResolver, 'forProject'>;
  ttlMs?: number;
  maxRequests?: number;
  now?: () => number;
  // Receives counts only, never report content.
  log?: (message: string) => void;
}

export function createReportMatcher(deps: ReportMatcherDeps) {
  const { sql, sources } = deps;
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const maxRequests = deps.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const cache = new Map<
    string,
    { expiresAt: number; map: Promise<PhoneMap | null> }
  >();
  let held: Held[] = [];
  let dropped = 0;
  let flushing: Promise<number> | null = null;

  async function load(
    projectId: string,
    requestId: string
  ): Promise<PhoneMap | null> {
    const rows = await sql.$queryRawUnsafe<TrackedRow[]>(
      `SELECT source_ref, profile_id, channel FROM marketing.message_tracking
       WHERE project_id = $1 AND provider_ref = $2`,
      projectId,
      requestId
    );
    if (rows.length === 0) {
      return null;
    }
    const source = await sources.forProject(projectId);
    if (!source) {
      throw new Error('source_unavailable');
    }
    const refOfProfile = new Map(
      rows.map((row) => [row.profile_id, row.source_ref])
    );
    const byPhone: PhoneMap = new Map();
    for (const channel of MSG91_CHANNELS) {
      const ids = rows
        .filter((row) => row.channel === channel)
        .map((row) => row.profile_id);
      for (let start = 0; start < ids.length; start += MAX_LOOKUP_IDS) {
        const entries = await source.lookup(
          ids.slice(start, start + MAX_LOOKUP_IDS),
          channel
        );
        for (const entry of entries) {
          const key = entry.phone
            ? phoneKey(entry.phone.replace(NON_DIGITS, ''))
            : null;
          const sourceRef = refOfProfile.get(entry.id);
          if (entry.status === 'ok' && key && sourceRef) {
            byPhone.set(key, sourceRef);
          }
        }
      }
    }
    return byPhone;
  }

  // One lookup per request id, shared by concurrent calls. An empty row set or a failure is never cached.
  function mapFor(projectId: string, requestId: string) {
    const key = `${projectId}:${requestId}`;
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now()) {
      return hit.map;
    }
    cache.delete(key);
    const map = load(projectId, requestId);
    const forget = () => {
      if (cache.get(key)?.map === map) {
        cache.delete(key);
      }
    };
    map.then((value) => value === null && forget(), forget);
    while (cache.size >= maxRequests) {
      const oldest = cache.keys().next();
      if (oldest.done) {
        break;
      }
      cache.delete(oldest.value);
    }
    cache.set(key, { expiresAt: now() + ttlMs, map });
    return map;
  }

  function hold(projectId: string, heldAt: number, reports: ParsedReport[]) {
    const room = Math.max(0, MAX_HELD_REPORTS - held.length);
    for (const report of reports.slice(0, room)) {
      held.push({ projectId, heldAt, report });
    }
    const lost = reports.length - Math.min(reports.length, room);
    if (lost > 0) {
      dropped += lost;
      deps.log?.(`msg91 early reports dropped: ${lost} (hold full)`);
    }
  }

  async function flushOnce(): Promise<number> {
    const batch = held;
    held = [];
    const cutoff = now() - HOLD_MS;
    const fresh = batch.filter((entry) => entry.heldAt >= cutoff);
    const expired = batch.length - fresh.length;
    if (expired > 0) {
      dropped += expired;
      deps.log?.(`msg91 early reports dropped: ${expired} (expired)`);
    }
    const byProject = new Map<string, Held[]>();
    for (const entry of fresh) {
      byProject.set(entry.projectId, [
        ...(byProject.get(entry.projectId) ?? []),
        entry,
      ]);
    }
    let applied = 0;
    let failure: unknown;
    for (const [projectId, entries] of byProject) {
      const updates: DeliveryUpdate[] = [];
      const withRequest = entries.map((entry) => ({
        entry,
        requestId: entry.report.requestId,
      }));
      for (const [requestId, group] of groupByRequest(withRequest)) {
        try {
          const map = await mapFor(projectId, requestId);
          if (map) {
            updates.push(
              ...toUpdates(
                map,
                group.map(({ entry }) => entry.report)
              ).updates
            );
            continue;
          }
        } catch (error) {
          failure ??= error;
        }
        for (const { entry } of group) {
          hold(projectId, entry.heldAt, [entry.report]);
        }
      }
      try {
        applied += await applyDeliveryUpdates(sql, projectId, updates);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) {
      throw failure;
    }
    return applied;
  }

  return {
    async match(
      projectId: string,
      reports: ParsedReport[]
    ): Promise<{ updates: DeliveryUpdate[]; unmatched: number }> {
      const updates: DeliveryUpdate[] = [];
      let unmatched = 0;
      for (const [requestId, group] of groupByRequest(reports)) {
        const map = await mapFor(projectId, requestId);
        if (!map) {
          hold(projectId, now(), group);
          continue;
        }
        const result = toUpdates(map, group);
        updates.push(...result.updates);
        unmatched += result.unmatched;
      }
      return { updates, unmatched };
    },
    // Retries the held reports and returns how many rows they updated. Overlapping calls share one run.
    flushHeld(): Promise<number> {
      flushing ??= flushOnce().finally(() => {
        flushing = null;
      });
      return flushing;
    },
    heldStats: () => ({ held: held.length, dropped }),
  };
}

export type ReportMatcher = ReturnType<typeof createReportMatcher>;
