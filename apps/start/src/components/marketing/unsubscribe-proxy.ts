import { errorResponse, isTimeout, ProxyError, readCappedBody } from './proxy';

const UNSUBSCRIBE_PATH = '/marketing/unsubscribe';
// The worker ignores the body (the signed token in the query is the authority); RFC 8058 bodies are tiny.
const MAX_BODY_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;
const ALLOWED_METHODS = new Set(['GET', 'POST']);
const PASSED_RESPONSE_HEADERS = [
  'content-security-policy',
  'content-type',
  'cache-control',
];
// Set here rather than forwarded: the token is in the URL and must not leak through a Referer.
const FIXED_RESPONSE_HEADERS = {
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

// Public, unauthenticated pass-through so unsubscribe links work on the dashboard's own origin.
export function createUnsubscribeProxy(deps: {
  marketingUrl: () => string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
}) {
  const fetchImpl = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? UPSTREAM_TIMEOUT_MS;

  async function forward(request: Request): Promise<Response> {
    const marketingUrl = deps.marketingUrl();
    const url = new URL(request.url);
    if (!marketingUrl || url.pathname !== UNSUBSCRIBE_PATH) {
      throw new ProxyError(404, 'not_found');
    }
    const method = request.method.toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      throw new ProxyError(405, 'method_not_allowed');
    }
    const isPost = method === 'POST';
    const headers: Record<string, string> = {};
    const contentType = request.headers.get('content-type');
    if (isPost && contentType) {
      headers['content-type'] = contentType;
    }
    // Verbatim: the edge proxy already appended the client; with MARKETING_TRUST_PROXY the worker reads the rightmost entry.
    const forwardedFor = request.headers.get('x-forwarded-for');
    if (forwardedFor) {
      headers['x-forwarded-for'] = forwardedFor;
    }
    const body = isPost ? await readCappedBody(request, MAX_BODY_BYTES) : null;
    let upstream: Response;
    try {
      upstream = await fetchImpl(
        new URL(`${UNSUBSCRIBE_PATH}${url.search}`, marketingUrl),
        {
          method,
          headers,
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        }
      );
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
