import { useCallback } from 'react';
import type { ApiIssue } from './contract';
import { labelErrorCode } from './error-labels';
import { labelSettingsIssue } from './reason-labels';
import { useAppParams } from '@/hooks/use-app-params';

const MARKETING_PROXY_PATH = '/marketing-api';

export class MarketingApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: ApiIssue[];
  readonly details: Record<string, unknown> | null;

  constructor(
    status: number,
    code: string,
    issues: ApiIssue[],
    details: Record<string, unknown> | null
  ) {
    super(code);
    this.status = status;
    this.code = code;
    this.issues = issues;
    this.details = details;
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

function detailsOf(body: unknown): Record<string, unknown> | null {
  return isRecord(body) && isRecord(body.details) ? body.details : null;
}

export async function marketingFetch<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('x-marketing-csrf', '1');
  if (init.body !== undefined) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(`${MARKETING_PROXY_PATH}/${path}`, {
    ...init,
    headers,
    credentials: 'same-origin',
  }).catch((error: unknown) => {
    if (error instanceof TypeError) {
      throw new MarketingApiError(0, 'network_error', [], null);
    }
    throw error;
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code =
      isRecord(body) && typeof body.error === 'string'
        ? body.error
        : `http_${response.status}`;
    throw new MarketingApiError(
      response.status,
      code,
      issuesOf(body),
      detailsOf(body)
    );
  }
  return body as T;
}

export function useMarketingFetch() {
  const { projectId } = useAppParams();
  return useCallback(
    <T>(path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set('x-marketing-project-id', projectId);
      return marketingFetch<T>(path, { ...init, headers });
    },
    [projectId]
  );
}

export function useMarketingQueryKey() {
  const { projectId } = useAppParams();
  return useCallback(
    (...parts: string[]) => ['marketing', projectId, ...parts],
    [projectId]
  );
}

export function describeMarketingError(error: unknown): string {
  if (!(error instanceof MarketingApiError)) {
    return 'Something went wrong';
  }
  const issues = error.issues
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join('; ');
  const message = labelErrorCode(error.code);
  const settingsIssues =
    error.code === 'invalid_settings' && Array.isArray(error.details?.issues)
      ? error.details.issues
          .map((issue) => labelSettingsIssue(String(issue)))
          .join('; ')
      : '';
  const extra = [issues, settingsIssues].filter(Boolean).join('; ');
  return extra ? `${message} (${extra})` : message;
}
