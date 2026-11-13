const MS_PER_SECOND = 1000;
const RETRY_AFTER_MIN_MS = 1000;
const RETRY_AFTER_MAX_MS = 60_000;
const RETRY_AFTER_DEFAULT_MS = 5000;

export function retryAfterMs(
  header: string | null,
  fallbackMs = RETRY_AFTER_DEFAULT_MS
): number {
  const clamp = (ms: number) =>
    Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, ms));
  const trimmed = header?.trim();
  if (!trimmed) {
    return clamp(fallbackMs);
  }
  if (/^\d+$/.test(trimmed)) {
    return clamp(Number(trimmed) * MS_PER_SECOND);
  }
  const date = Date.parse(trimmed);
  return clamp(Number.isNaN(date) ? fallbackMs : date - Date.now());
}
