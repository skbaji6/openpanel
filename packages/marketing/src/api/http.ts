import type { z } from 'zod';

export const MAX_BODY_BYTES = 1024 * 1024;
// Postgres text and jsonb cannot store NUL, so it is rejected up front instead of failing the write.
const ESCAPED_NUL = '\\u0000';

export interface Issue {
  path: string;
  message: string;
}

export type RouteAuth = 'public' | 'apiKey' | 'dashboard' | 'apiKeyOrDashboard';

export interface RouteContext {
  req: Request;
  url: URL;
  params: string[];
  // Empty for public routes.
  projectId: string;
  // Empty unless the route is authenticated as the dashboard.
  userId: string;
  ip: string;
}

export interface Route {
  method: string;
  pattern: RegExp;
  auth: RouteAuth;
  handle(ctx: RouteContext): Promise<Response> | Response;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues?: Issue[];
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    issues?: Issue[],
    details?: Record<string, unknown>
  ) {
    super(code);
    this.status = status;
    this.code = code;
    this.issues = issues;
    this.details = details;
  }
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

// Counts bytes as they arrive, so a body without (or lying about) content-length is cut off too.
export async function readBodyText(
  req: Request,
  maxBytes = MAX_BODY_BYTES
): Promise<string> {
  const declared = Number(req.headers.get('content-length'));
  if (declared > maxBytes) {
    throw new HttpError(413, 'payload_too_large');
  }
  if (!req.body) {
    return '';
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, 'payload_too_large');
    }
    chunks.push(value);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks)
    );
  } catch {
    throw new HttpError(400, 'invalid_body');
  }
}

export function validate<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new HttpError(
      400,
      'invalid_body',
      parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      }))
    );
  }
  return parsed.data;
}

export async function parseJsonBody<T>(
  req: Request,
  schema: z.ZodType<T>
): Promise<T> {
  const text = await readBodyText(req);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
  if (text.includes(ESCAPED_NUL)) {
    throw new HttpError(400, 'invalid_body');
  }
  return validate(schema, data);
}
