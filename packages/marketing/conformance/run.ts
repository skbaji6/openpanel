import { checks, createContext, type Target } from './checks';

export interface ConformanceResult {
  passed: number;
  failed: { check: string; detail: string }[];
  warnings: { check: string; detail: string }[];
}

const MAX_DETAIL_LENGTH = 300;

export async function runConformance(
  target: Target,
  // Milliseconds; injectable so the service-level warnings can be tested without slow targets.
  options: { clock?: () => number } = {}
): Promise<ConformanceResult> {
  const result: ConformanceResult = { passed: 0, failed: [], warnings: [] };
  // Details come from our own messages and short client errors; the secret is masked in case a target echoes it.
  const clean = (detail: string) =>
    detail.replaceAll(target.secret, '[secret]').slice(0, MAX_DETAIL_LENGTH);
  const ctx = createContext(
    target,
    options.clock ?? (() => performance.now()),
    (check, detail) => result.warnings.push({ check, detail: clean(detail) })
  );
  for (const check of checks) {
    try {
      await check.run(ctx);
      result.passed += 1;
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      result.failed.push({ check: check.name, detail: clean(detail) });
    }
  }
  return result;
}
