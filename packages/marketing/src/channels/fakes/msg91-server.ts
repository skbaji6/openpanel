import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';

export const SMS_PATH = '/api/v5/flow';
export const WHATSAPP_PATH = '/api/v5/whatsapp/whatsapp-outbound-message/bulk/';

type FakePath = typeof SMS_PATH | typeof WHATSAPP_PATH;

const LOOPBACK = '127.0.0.1';
const OK_STATUS = 200;
const BAD_REQUEST_STATUS = 400;
const UNAUTHORIZED_STATUS = 401;
const NOT_FOUND_STATUS = 404;
const RATE_LIMITED_STATUS = 429;
const SERVER_ERROR_STATUS = 500;
const MALFORMED_BODY = '<html>upstream gateway hiccup</html>';

export interface FakeRequest {
  path: string;
  authkey: string | null;
  contentType: string | null;
  body: unknown;
}

export interface ScriptedResponse {
  status: number;
  headers?: Record<string, string>;
  /** A string is sent as is (so it can be garbage); anything else as JSON. */
  body: unknown;
  /** Phones in an otherwise accepted request that the provider rejected. */
  failedPhones?: string[];
}

/** `index` is per path and keeps counting across `script()` calls. */
export type Responder = (
  body: unknown,
  index: number
) => ScriptedResponse | 'hang' | 'reset';

export interface FakeMsg91 {
  baseUrl: string;
  requests: FakeRequest[];
  connections: () => number;
  /** Most requests that were being handled at the same moment. */
  peakInFlight: () => number;
  /** Destroys every open socket, as a server closing its idle keep-alive connections. */
  dropSockets: () => void;
  script: (path: FakePath, responder: Responder | 'hang' | 'reset') => void;
  /** Any 2xx counts as delivered: the provider may have accepted it. */
  delivered: Map<string, number>;
  close: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** `mobiles` is one phone per recipient; it is not split on commas. Phones from the SMS `recipients[].mobiles` and WhatsApp `to_and_components[].to[]` shapes. */
export function extractPhones(body: unknown): string[] {
  if (!isRecord(body)) {
    return [];
  }
  const phones: string[] = [];
  for (const recipient of asArray(body.recipients)) {
    if (isRecord(recipient) && typeof recipient.mobiles === 'string') {
      phones.push(recipient.mobiles);
    }
  }
  const template = isRecord(body.payload) ? body.payload.template : undefined;
  const entries = isRecord(template) ? template.to_and_components : undefined;
  for (const entry of asArray(entries)) {
    if (!isRecord(entry)) {
      continue;
    }
    for (const phone of asArray(entry.to)) {
      if (typeof phone === 'string') {
        phones.push(phone);
      }
    }
  }
  return phones;
}

const requestId = () => randomUUID();

const defaultResponders: Record<FakePath, Responder> = {
  [SMS_PATH]: () => ({
    status: OK_STATUS,
    body: { type: 'success', message: requestId() },
  }),
  [WHATSAPP_PATH]: () => ({
    status: OK_STATUS,
    body: { status: 'success', hasError: false, request_id: requestId() },
  }),
};

export const responses = {
  rateLimited:
    (retryAfterSeconds: number): Responder =>
    () => ({
      status: RATE_LIMITED_STATUS,
      headers: { 'retry-after': String(retryAfterSeconds) },
      body: { type: 'error', message: 'rate limited' },
    }),
  authFailed: (): Responder => () => ({
    status: UNAUTHORIZED_STATUS,
    body: { type: 'error', message: 'AuthenticationFailure' },
  }),
  serverError: (): Responder => () => ({
    status: SERVER_ERROR_STATUS,
    body: { type: 'error', message: 'internal error' },
  }),
  malformed: (): Responder => () => ({
    status: OK_STATUS,
    body: MALFORMED_BODY,
  }),
  badRequestIfPhone:
    (phone: string): Responder =>
    (body) =>
      extractPhones(body).includes(phone)
        ? {
            status: BAD_REQUEST_STATUS,
            body: { type: 'error', message: 'invalid mobile' },
          }
        : defaultResponders[SMS_PATH](body, 0),
  /** WhatsApp per-recipient shape; the real one is unconfirmed. */
  partial:
    (failedPhones: string[]): Responder =>
    (body) => ({
      status: OK_STATUS,
      failedPhones,
      body: {
        status: 'success',
        hasError: true,
        request_id: requestId(),
        results: extractPhones(body).map((to) =>
          failedPhones.includes(to)
            ? { to, status: 'failed', error_code: 'invalid_number' }
            : { to, status: 'success' }
        ),
      },
    }),
};

const isFakePath = (path: string): path is FakePath =>
  path === SMS_PATH || path === WHATSAPP_PATH;

export function startFakeMsg91(
  opts: { delayMs?: number } = {}
): Promise<FakeMsg91> {
  const requests: FakeRequest[] = [];
  const delivered = new Map<string, number>();
  const responders = new Map<FakePath, Responder | 'hang' | 'reset'>();
  const counts = new Map<FakePath, number>();
  const sockets = new Set<Socket>();
  let connectionCount = 0;
  let inFlight = 0;
  let peakInFlight = 0;

  const timers = new Set<ReturnType<typeof setTimeout>>();
  const delay = () =>
    new Promise<void>((resolve) => {
      if (!opts.delayMs) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, opts.delayMs);
      timers.add(timer);
    });

  const server = createServer(async (req, res) => {
    inFlight++;
    peakInFlight = Math.max(peakInFlight, inFlight);
    res.on('close', () => {
      inFlight--;
    });
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
    } catch {
      // client aborted mid-body: nothing was received, so nothing is recorded
      req.socket.destroy();
      return;
    }
    const path = (req.url ?? '').split('?')[0] ?? '';
    const authkey = req.headers.authkey;
    const entry = {
      path,
      authkey: typeof authkey === 'string' ? authkey : null,
      contentType: req.headers['content-type'] ?? null,
    };

    let body: unknown = null;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      requests.push({ ...entry, body: null });
      await delay();
      res.writeHead(BAD_REQUEST_STATUS, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', message: 'invalid json' }));
      return;
    }
    requests.push({ ...entry, body });

    if (!isFakePath(path) || req.method !== 'POST') {
      await delay();
      res.writeHead(NOT_FOUND_STATUS);
      res.end();
      return;
    }

    const index = counts.get(path) ?? 0;
    counts.set(path, index + 1);
    const responder = responders.get(path) ?? defaultResponders[path];
    const answer =
      typeof responder === 'function' ? responder(body, index) : responder;

    await delay();
    if (answer === 'hang') {
      return;
    }
    if (answer === 'reset') {
      // Bun's resetAndDestroy() leaves fetch hanging instead of sending an RST, so destroy() it is
      req.socket.destroy();
      return;
    }

    if (answer.status >= OK_STATUS && answer.status < 300) {
      const failed = new Set(answer.failedPhones);
      for (const phone of extractPhones(body)) {
        if (!failed.has(phone)) {
          delivered.set(phone, (delivered.get(phone) ?? 0) + 1);
        }
      }
    }
    const isText = typeof answer.body === 'string';
    res.writeHead(answer.status, {
      'content-type': isText ? 'text/html' : 'application/json',
      ...answer.headers,
    });
    res.end(isText ? (answer.body as string) : JSON.stringify(answer.body));
  });

  server.on('connection', (socket) => {
    connectionCount++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const timer of timers) {
        clearTimeout(timer);
      }
      // hanging requests and keep-alive sockets would otherwise hold close() open
      for (const socket of sockets) {
        socket.destroy();
      }
    });
    return closing;
  };

  return new Promise((resolve) => {
    server.listen(0, LOOPBACK, () => {
      const address = server.address();
      const port = isRecord(address) ? address.port : 0;
      resolve({
        baseUrl: `http://${LOOPBACK}:${port}`,
        requests,
        connections: () => connectionCount,
        peakInFlight: () => peakInFlight,
        dropSockets: () => {
          for (const socket of sockets) {
            socket.destroy();
          }
        },
        script: (path, responder) => {
          responders.set(path, responder);
        },
        delivered,
        close,
      });
    });
  });
}
