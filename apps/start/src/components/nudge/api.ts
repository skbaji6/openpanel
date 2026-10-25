import { useCallback } from 'react';
import type { ApiIssue } from './contract';
import { useAppParams } from '@/hooks/use-app-params';

const NUDGE_PROXY_PATH = '/api/nudge';

export class NudgeApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: ApiIssue[];

  constructor(status: number, code: string, issues: ApiIssue[]) {
    super(code);
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function issuesOf(body: unknown): ApiIssue[] {
  if (!(isRecord(body) && Array.isArray(body.issues))) {
    return [];
  }
  return body.issues.filter(
    (issue): issue is ApiIssue =>
      isRecord(issue) &&
      typeof issue.path === 'string' &&
      typeof issue.message === 'string'
  );
}

export async function nudgeFetch<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('x-nudge-csrf', '1');
  if (init.body !== undefined) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(`${NUDGE_PROXY_PATH}/${path}`, {
    ...init,
    headers,
    credentials: 'same-origin',
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code =
      isRecord(body) && typeof body.error === 'string'
        ? body.error
        : `http_${response.status}`;
    throw new NudgeApiError(response.status, code, issuesOf(body));
  }
  return body as T;
}

export function useNudgeFetch() {
  const { projectId } = useAppParams();
  return useCallback(
    <T>(path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set('x-nudge-project-id', projectId);
      return nudgeFetch<T>(path, { ...init, headers });
    },
    [projectId]
  );
}

export function useNudgeQueryKey() {
  const { projectId } = useAppParams();
  return useCallback(
    (...parts: string[]) => ['nudge', projectId, ...parts],
    [projectId]
  );
}

const ERROR_MESSAGES: Record<string, string> = {
  forbidden: 'You do not have permission to do this',
  not_found: 'Not found',
  secrets_required: 'Re-enter the secrets for this channel',
  rule_reactivated: 'The rule was reactivated while deleting; try again',
  payload_too_large: 'The request is too large',
};

export function describeNudgeError(error: unknown): string {
  if (!(error instanceof NudgeApiError)) {
    return 'Something went wrong';
  }
  const issues = error.issues
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join('; ');
  const message = ERROR_MESSAGES[error.code] ?? error.code;
  return issues ? `${message} (${issues})` : message;
}
