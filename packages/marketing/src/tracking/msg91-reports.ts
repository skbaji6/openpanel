import type { ReportStatus } from './delivery';

export interface ParsedReport {
  requestId: string;
  /** Digits only. Held in memory to match a recipient, never stored or logged. */
  number: string;
  status: ReportStatus;
  at: Date;
  reason: string | null;
}

export const MAX_REPORTS_PER_CALL = 5000;

const SMS_DELIVERED = '1';
const SMS_FAILED = new Set(['2', '9', '16', '17', '25', '26']);
const WHATSAPP_STATUSES = new Set<string>(['delivered', 'read', 'failed']);
const WHATSAPP_FAILED_REASON = 'msg91_failed';
const MAX_REQUEST_ID_LENGTH = 200;
const EPOCH_SECONDS_LIMIT = 1e11;
const MS_PER_SECOND = 1000;
const MAX_UNWRAP_DEPTH = 2;
const DATE_KEYS = ['timestamp', 'date', 'time'] as const;
const NON_DIGITS = /\D/g;

type Item = Record<string, unknown>;
interface Outcome {
  status: ReportStatus;
  reason: string | null;
}

const isItem = (value: unknown): value is Item =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// A form body is `data=<url-encoded json>`.
function parseText(text: string): unknown {
  const asJson = parseJson(text);
  if (asJson !== null) {
    return asJson;
  }
  const field = new URLSearchParams(text).get('data');
  return field === null ? null : parseJson(field);
}

function toItems(body: unknown, depth = 0): unknown[] {
  if (depth > MAX_UNWRAP_DEPTH) {
    return [];
  }
  if (typeof body === 'string') {
    return toItems(parseText(body), depth + 1);
  }
  if (Array.isArray(body)) {
    return body;
  }
  if (!isItem(body)) {
    return [];
  }
  return 'data' in body && !('requestId' in body)
    ? toItems(body.data, depth + 1)
    : [body];
}

function parseDate(value: unknown, fallback: Date): Date {
  let date = fallback;
  if (typeof value === 'number' && Number.isFinite(value)) {
    date = new Date(
      value < EPOCH_SECONDS_LIMIT ? value * MS_PER_SECOND : value
    );
  } else if (typeof value === 'string' && value.length > 0) {
    date = new Date(value);
  }
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function readAt(item: Item, receivedAt: Date): Date {
  const key = DATE_KEYS.find((candidate) => item[candidate] !== undefined);
  return key ? parseDate(item[key], receivedAt) : receivedAt;
}

function readRequestId(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  const id = String(value);
  return id.length > 0 && id.length <= MAX_REQUEST_ID_LENGTH ? id : null;
}

function readDigits(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  const digits = String(value).replace(NON_DIGITS, '');
  return digits.length > 0 ? digits : null;
}

function smsOutcome(status: unknown): Outcome | null {
  const code = String(status);
  if (code === SMS_DELIVERED) {
    return { status: 'delivered', reason: null };
  }
  return SMS_FAILED.has(code)
    ? { status: 'failed', reason: `msg91_${code}` }
    : null;
}

function whatsAppOutcome(status: unknown): Outcome | null {
  if (typeof status !== 'string' || !WHATSAPP_STATUSES.has(status)) {
    return null;
  }
  return {
    status: status as ReportStatus,
    reason: status === 'failed' ? WHATSAPP_FAILED_REASON : null,
  };
}

// Never throws and never returns the provider's `desc` text.
export function parseMsg91Reports(
  body: unknown,
  receivedAt: Date = new Date()
): { reports: ParsedReport[]; ignored: number } {
  const reports: ParsedReport[] = [];
  let ignored = 0;
  const push = (
    requestId: unknown,
    number: unknown,
    outcome: Outcome | null,
    at: Date
  ) => {
    const id = readRequestId(requestId);
    const digits = readDigits(number);
    if (id && digits && outcome) {
      reports.push({ requestId: id, number: digits, at, ...outcome });
    } else {
      ignored++;
    }
  };
  try {
    for (const item of toItems(body)) {
      if (!isItem(item)) {
        ignored++;
      } else if (Array.isArray(item.report)) {
        for (const entry of item.report) {
          if (isItem(entry)) {
            push(
              item.requestId,
              entry.number,
              smsOutcome(entry.status),
              readAt(entry, receivedAt)
            );
          } else {
            ignored++;
          }
        }
      } else {
        push(
          item.requestId,
          item.customerNumber,
          whatsAppOutcome(item.status),
          readAt(item, receivedAt)
        );
      }
    }
  } catch {
    // Hostile shapes (getters, proxies) must not reach the caller.
  }
  return { reports, ignored };
}
