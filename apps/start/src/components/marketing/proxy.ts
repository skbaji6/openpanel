const PROXY_PREFIX = '/marketing-api/';
const MAX_BODY_BYTES = 1024 * 1024;
const ACCESS_CACHE_TTL_MS = 30_000;
const ACCESS_CACHE_MAX = 1000;
// Same format the marketing service accepts for forwarded identities.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CONTROL_CHARACTERS = /\p{Cc}/u;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ORGANIZATION_ADMIN_ROLES = new Set(['owner', 'admin']);
const DENIED_STATUSES = new Set([401, 403, 404]);
const CORE_TIMEOUT_MS = 10_000;
// Pausing or deleting a rule may wait up to 150 s in the service (120 s transaction + 30 s lock wait).
const MARKETING_TIMEOUT_MS = 155_000;

type Requirement = 'member' | 'admin';

// Everything not listed here (unsubscribe, contact and device sync) is never reachable through the dashboard.
const ALLOWED_ROUTES: {
  pattern: RegExp;
  methods: Partial<Record<string, Requirement>>;
}[] = [
  { pattern: /^rules$/, methods: { GET: 'member', POST: 'admin' } },
  { pattern: /^rules\/[^/]+$/, methods: { PATCH: 'admin', DELETE: 'admin' } },
  { pattern: /^rules\/[^/]+\/start$/, methods: { POST: 'admin' } },
  { pattern: /^rules\/[^/]+\/skips$/, methods: { GET: 'member' } },
  { pattern: /^starter-rules$/, methods: { GET: 'member' } },
  {
    pattern: /^channels\/(email|webhook|push|sms|whatsapp)$/,
    methods: { GET: 'admin', PUT: 'admin' },
  },
  {
    pattern: /^channels\/(push|whatsapp|sms|email|webhook)\/settings$/,
    methods: { GET: 'member', PUT: 'admin' },
  },
  { pattern: /^templates$/, methods: { GET: 'member', POST: 'admin' } },
  {
    pattern: /^templates\/[^/]+$/,
    methods: { GET: 'member', PUT: 'admin' },
  },
  {
    pattern: /^templates\/[^/]+\/versions\/[0-9]+$/,
    methods: { GET: 'member' },
  },
  { pattern: /^templates\/[^/]+\/preview$/, methods: { POST: 'member' } },
  {
    pattern: /^templates\/[^/]+\/(enable|disable)$/,
    methods: { POST: 'admin' },
  },
  { pattern: /^audience-source$/, methods: { GET: 'admin', PUT: 'admin' } },
  { pattern: /^audience-source\/test$/, methods: { POST: 'admin' } },
  { pattern: /^settings$/, methods: { GET: 'member', PUT: 'admin' } },
  { pattern: /^results$/, methods: { GET: 'member' } },
  { pattern: /^api-keys$/, methods: { POST: 'admin' } },
  { pattern: /^preview$/, methods: { POST: 'member' } },
  { pattern: /^reference-sets$/, methods: { GET: 'member' } },
  {
    pattern: /^reference-sets\/[^/]+$/,
    methods: { GET: 'member', PUT: 'admin' },
  },
  { pattern: /^audience\/schema$/, methods: { GET: 'member' } },
  {
    pattern: /^audience\/dimensions\/[^/]+\/values$/,
    methods: { GET: 'member' },
  },
  { pattern: /^audience\/resolve$/, methods: { POST: 'member' } },
  { pattern: /^audiences$/, methods: { GET: 'member', POST: 'member' } },
  {
    pattern: /^audiences\/[^/]+$/,
    methods: { GET: 'member', PUT: 'member', DELETE: 'admin' },
  },
  {
    pattern: /^audiences\/[^/]+\/ids$/,
    methods: { GET: 'member', POST: 'member' },
  },
  {
    pattern: /^audiences\/[^/]+\/(count|preview|explain|freeze)$/,
    methods: { POST: 'member' },
  },
  { pattern: /^campaigns$/, methods: { GET: 'member', POST: 'member' } },
  {
    pattern: /^campaigns\/[^/]+$/,
    methods: { GET: 'member', PATCH: 'member', DELETE: 'admin' },
  },
  {
    pattern: /^campaigns\/[^/]+\/count-preview$/,
    methods: { POST: 'member' },
  },
  {
    pattern: /^campaigns\/[^/]+\/(recipients|skip-reasons|test-sends)$/,
    methods: { GET: 'member' },
  },
  { pattern: /^campaigns\/[^/]+\/estimate$/, methods: { POST: 'member' } },
  {
    pattern: /^campaigns\/[^/]+\/retry-uncertain$/,
    methods: { POST: 'admin' },
  },
  {
    pattern:
      /^campaigns\/[^/]+\/(start|schedule|unschedule|pause|resume|cancel|test-send)$/,
    methods: { POST: 'admin' },
  },
];

export interface ProxyEnv {
  marketingUrl?: string;
  proxySecret?: string;
  apiUrl?: string;
  dashboardUrl?: string;
}

interface Access {
  userId: string;
  isAdmin: boolean;
}

type CoreAnswer =
  | { status: 'ok'; data: unknown }
  | { status: 'denied' }
  | { status: 'error' };

export function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

export class ProxyError extends Error {
  readonly status: number;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
  }
}

export function errorResponse(status: number, code: string): Response {
  return Response.json(
    { error: code },
    { status, headers: { 'cache-control': 'no-store' } }
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

function isSafeSegment(segment: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return false;
  }
  const isDotSegment = decoded === '.' || decoded === '..';
  return (
    decoded.length > 0 &&
    !isDotSegment &&
    !/[/\\]/.test(decoded) &&
    !CONTROL_CHARACTERS.test(decoded)
  );
}

function requirementFor(path: string, method: string): Requirement {
  const segmentsAreSafe = path.split('/').every(isSafeSegment);
  const route = segmentsAreSafe
    ? ALLOWED_ROUTES.find((candidate) => candidate.pattern.test(path))
    : undefined;
  if (!route) {
    throw new ProxyError(404, 'not_found');
  }
  const requirement = route.methods[method];
  if (!requirement) {
    throw new ProxyError(405, 'method_not_allowed');
  }
  return requirement;
}

function allowedOrigins(request: Request, env: ProxyEnv): Set<string> {
  const origins = new Set([new URL(request.url).origin]);
  if (env.dashboardUrl) {
    origins.add(new URL(env.dashboardUrl).origin);
  }
  return origins;
}

// The session cookie is SameSite=lax, so a mutating call must prove it came from the dashboard itself.
function assertSameOrigin(request: Request, env: ProxyEnv): void {
  const { headers } = request;
  const fetchSite = headers.get('sec-fetch-site');
  const origin = headers.get('origin');
  const csrfHeaderSet = headers.get('x-marketing-csrf') === '1';
  const fetchSiteAllowed = fetchSite === null || fetchSite === 'same-origin';
  const originAllowed =
    origin !== null && allowedOrigins(request, env).has(origin);
  if (!(csrfHeaderSet && fetchSiteAllowed && originAllowed)) {
    throw new ProxyError(403, 'forbidden');
  }
}

export async function readCappedBody(
  request: Request,
  maxBytes = MAX_BODY_BYTES
): Promise<ArrayBuffer | null> {
  if (!request.body) {
    return null;
  }
  if (Number(request.headers.get('content-length')) > maxBytes) {
    throw new ProxyError(413, 'payload_too_large');
  }
  const reader = request.body.getReader();
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
      throw new ProxyError(413, 'payload_too_large');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

export function createMarketingProxy(deps: {
  env: () => ProxyEnv;
  fetch?: typeof fetch;
  now?: () => number;
  timeouts?: { coreMs: number; marketingMs: number };
}) {
  const fetchImpl = deps.fetch ?? fetch;
  const timeouts = deps.timeouts ?? {
    coreMs: CORE_TIMEOUT_MS,
    marketingMs: MARKETING_TIMEOUT_MS,
  };
  const now = deps.now ?? Date.now;
  const accessCache = new Map<
    string,
    { access: Access | null; expiresAt: number }
  >();

  async function queryCore(
    apiUrl: string,
    cookie: string,
    procedure: string,
    input?: unknown
  ): Promise<CoreAnswer> {
    const query =
      input === undefined
        ? ''
        : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
    try {
      const response = await fetchImpl(`${apiUrl}/trpc/${procedure}${query}`, {
        headers: { cookie },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeouts.coreMs),
      });
      if (DENIED_STATUSES.has(response.status)) {
        return { status: 'denied' };
      }
      if (!response.ok) {
        return { status: 'error' };
      }
      const body: unknown = await response.json();
      const result = isRecord(body) ? body.result : undefined;
      const data = isRecord(result) ? result.data : undefined;
      return { status: 'ok', data: isRecord(data) ? data.json : undefined };
    } catch (error) {
      if (isTimeout(error)) {
        throw new ProxyError(504, 'core_timeout');
      }
      return { status: 'error' };
    }
  }

  // Returns null when core says the user may not see the project; throws when core could not answer.
  async function lookUpAccess(
    apiUrl: string,
    cookie: string,
    projectId: string
  ): Promise<Access | null> {
    const session = await queryCore(apiUrl, cookie, 'auth.session');
    const project = await queryCore(
      apiUrl,
      cookie,
      'project.getProjectWithClients',
      { projectId }
    );
    if (session.status === 'error' || project.status === 'error') {
      throw new ProxyError(403, 'forbidden');
    }
    const userId =
      session.status === 'ok' && isRecord(session.data)
        ? session.data.userId
        : undefined;
    const organizationId =
      project.status === 'ok' && isRecord(project.data)
        ? project.data.organizationId
        : undefined;
    if (!(typeof userId === 'string' && typeof organizationId === 'string')) {
      return null;
    }
    const membership = await queryCore(
      apiUrl,
      cookie,
      'organization.myAccess',
      { organizationId }
    );
    if (membership.status === 'error') {
      throw new ProxyError(403, 'forbidden');
    }
    const role =
      membership.status === 'ok' && isRecord(membership.data)
        ? membership.data.role
        : undefined;
    return {
      userId,
      isAdmin: typeof role === 'string' && ORGANIZATION_ADMIN_ROLES.has(role),
    };
  }

  async function accessFor(
    apiUrl: string,
    cookie: string,
    projectId: string
  ): Promise<Access | null> {
    const cacheKey = `${await sha256Hex(cookie)}:${projectId}`;
    const cached = accessCache.get(cacheKey);
    if (cached && cached.expiresAt > now()) {
      return cached.access;
    }
    accessCache.delete(cacheKey);
    const access = await lookUpAccess(apiUrl, cookie, projectId);
    const oldest = accessCache.keys().next();
    if (accessCache.size >= ACCESS_CACHE_MAX && !oldest.done) {
      accessCache.delete(oldest.value);
    }
    accessCache.set(cacheKey, {
      access,
      expiresAt: now() + ACCESS_CACHE_TTL_MS,
    });
    return access;
  }

  async function forward(request: Request): Promise<Response> {
    const env = deps.env();
    const { marketingUrl, proxySecret, apiUrl } = env;
    if (!(marketingUrl && proxySecret && apiUrl)) {
      throw new ProxyError(404, 'not_found');
    }
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PROXY_PREFIX)) {
      throw new ProxyError(404, 'not_found');
    }
    const path = url.pathname.slice(PROXY_PREFIX.length);
    const method = request.method.toUpperCase();
    const requirement = requirementFor(path, method);
    const isMutating = MUTATING_METHODS.has(method);
    if (isMutating) {
      assertSameOrigin(request, env);
    }
    const projectId = request.headers.get('x-marketing-project-id') ?? '';
    if (!ID_PATTERN.test(projectId)) {
      throw new ProxyError(400, 'invalid_project');
    }
    const cookie = request.headers.get('cookie');
    if (!cookie) {
      throw new ProxyError(403, 'forbidden');
    }
    const access = await accessFor(apiUrl, cookie, projectId);
    const allowed =
      access !== null && (requirement === 'member' || access.isAdmin);
    if (!(access && allowed)) {
      throw new ProxyError(403, 'forbidden');
    }
    const body = isMutating ? await readCappedBody(request) : null;
    const target = new URL(`/marketing/${path}${url.search}`, marketingUrl);
    if (target.pathname !== `/marketing/${path}`) {
      throw new ProxyError(404, 'not_found');
    }
    const headers: Record<string, string> = {
      'x-marketing-proxy-secret': proxySecret,
      'x-marketing-project-id': projectId,
      'x-marketing-user-id': access.userId,
    };
    if (isMutating) {
      headers['x-marketing-csrf'] = '1';
      headers['content-type'] = 'application/json';
    }
    let upstream: Response;
    try {
      upstream = await fetchImpl(target, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeouts.marketingMs),
      });
    } catch (error) {
      if (isTimeout(error)) {
        throw new ProxyError(504, 'marketing_timeout');
      }
      throw new ProxyError(502, 'marketing_unavailable');
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'content-type':
          upstream.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
      },
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

  return { handle, cacheSize: () => accessCache.size };
}
