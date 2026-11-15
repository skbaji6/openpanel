import { errorResponse, isTimeout, ProxyError, readCappedBody } from './proxy';

// Anything outside these two shapes is 404 before the service is called. Tokens and secrets are
// URL-safe base64 (plus the "." in a link token); a project id is a slug.
const REDIRECT_PATH = /^\/marketing\/r\/[A-Za-z0-9_.-]{20,512}$/;
const WEBHOOK_PATH =
  /^\/marketing\/webhooks\/msg91\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{16,128}$/;
const MAX_WEBHOOK_BODY_BYTES = 512 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;
const PASSED_RESPONSE_HEADERS = [
  'content-type',
  'cache-control',
  'x-robots-tag',
];
const FIXED_RESPONSE_HEADERS = {
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

// Public and unauthenticated: link clicks and the MSG91 delivery webhook reach the service
// through the dashboard's own origin. The URL carries a token or secret, so nothing is logged.
export function createTrackingProxy(deps: {
  marketingUrl: () => string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
}) {
  const fetchImpl = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? UPSTREAM_TIMEOUT_MS;

  async function forward(request: Request): Promise<Response> {
    const marketingUrl = deps.marketingUrl();
    const { pathname } = new URL(request.url);
    const method = request.method.toUpperCase();
    const isRedirect = REDIRECT_PATH.test(pathname);
    const isWebhook = WEBHOOK_PATH.test(pathname);
    if (!(marketingUrl && (isRedirect || isWebhook))) {
      throw new ProxyError(404, 'not_found');
    }
    if (method !== (isRedirect ? 'GET' : 'POST')) {
      throw new ProxyError(405, 'method_not_allowed');
    }
    const headers: Record<string, string> = {};
    const forwardedFor = request.headers.get('x-forwarded-for');
    if (forwardedFor) {
      headers['x-forwarded-for'] = forwardedFor;
    }
    let body: ArrayBuffer | null = null;
    if (isWebhook) {
      const contentType = request.headers.get('content-type');
      if (contentType) {
        headers['content-type'] = contentType;
      }
      body = await readCappedBody(request, MAX_WEBHOOK_BODY_BYTES);
    }
    let upstream: Response;
    try {
      // The query is dropped: neither endpoint reads one.
      upstream = await fetchImpl(new URL(pathname, marketingUrl), {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (isTimeout(error)) {
        throw new ProxyError(504, 'marketing_timeout');
      }
      throw new ProxyError(502, 'marketing_unavailable');
    }
    const responseHeaders = new Headers(FIXED_RESPONSE_HEADERS);
    for (const name of PASSED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) {
        responseHeaders.set(name, value);
      }
    }
    const location = upstream.headers.get('location');
    if (location !== null && isRedirectStatus(upstream.status)) {
      responseHeaders.set('location', location);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  }

  async function handle(request: Request): Promise<Response> {
    try {
      return await forward(request);
    } catch (error) {
      if (error instanceof ProxyError) {
        return errorResponse(error.status, error.message);
      }
      return errorResponse(500, 'internal');
    }
  }

  return { handle };
}
