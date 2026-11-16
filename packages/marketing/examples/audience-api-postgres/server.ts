import { z } from 'zod';
import {
  type Dimension,
  type Explanation,
  type FilterTree,
  type LookupChannel,
  type LookupEntry,
  MAX_PAGE_SIZE,
  type Schema,
  zFilterTree,
  zLookupRequest,
  zMembersRequest,
  zResolveRequest,
} from '../../src/audience/contract';
import { validateFilter } from '../../src/audience/filter';
import { MAX_BODY_BYTES } from '../../src/audience/http-source';
import { verifyRequest } from '../../src/audience/signing';
import {
  bind,
  bindList,
  collectConditions,
  compileCondition,
  compileFilter,
  idExpression,
  quote,
  studentColumn,
  studentsFrom,
} from './compile';
import { type Mapping, parseMapping } from './mapping';

const MS_PER_SECOND = 1000;
const NONCE_TTL_MS = 120_000;
const DEFAULT_VALUES_LIMIT = 50;
const MIN_PHONE_DIGITS = 8;
const MAX_PHONE_DIGITS = 15;
const MASK_SUFFIX = '***';

const STATUS_UNAUTHORIZED = 401;
const STATUS_BAD_REQUEST = 400;
const STATUS_NOT_FOUND = 404;
const STATUS_TOO_LARGE = 413;
const STATUS_INTERNAL = 500;

export interface ServerOptions {
  mapping: Mapping;
  db: {
    query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
  };
  keys: { id: string; secret: string }[];
  // Milliseconds, like the client's `now`.
  now?: () => number;
  // Route prefix when the service is mounted below the origin root, e.g. /internal/audience.
  basePath?: string;
}

type Row = Record<string, unknown>;

// Messages are fixed strings: a response never echoes anything the caller sent.
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const badRequest = (message = 'invalid request') =>
  new HttpError(STATUS_BAD_REQUEST, message);

const zCountRequest = z.object({ filter: zFilterTree });
const zExplainRequest = z.object({ filter: zFilterTree, id: z.string() });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}

// shortcut: single-instance replay cache; behind several replicas use a shared store (Redis SET NX EX).
function createNonceCache(now: () => number) {
  const seen = new Map<string, number>();
  return {
    // Entries share one TTL, so the Map's insertion order is expiry order.
    async seenBefore(nonce: string, ttlSeconds: number): Promise<boolean> {
      const current = now();
      for (const [key, expiresAt] of seen) {
        if (expiresAt > current) {
          break;
        }
        seen.delete(key);
      }
      if (seen.has(nonce)) {
        return true;
      }
      seen.set(
        nonce,
        current + Math.max(ttlSeconds * MS_PER_SECOND, NONCE_TTL_MS)
      );
      return false;
    },
  };
}

function schemaOf(mapping: Mapping): Schema {
  const dimensions: Dimension[] = mapping.dimensions.map((d) => ({
    key: d.key,
    label: d.label,
    type: d.type,
    multiValued: d.multiValued,
    valuesListable: d.values !== undefined || d.staticValues !== undefined,
  }));
  return { dimensions };
}

function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): string {
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (id === '') {
    throw badRequest();
  }
  return id;
}

function maskName(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${word[0]}${MASK_SUFFIX}`)
    .join(' ');
}

function decodeKey(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw badRequest();
  }
}

const digitsOf = (value: string) => value.replace(/\D/g, '');

// Streams the body with a running byte count so an oversize chunked upload is
// abandoned at the cap instead of buffered; signing takes a string, so the
// bytes must be valid UTF-8.
async function readBodyCapped(
  req: Request
): Promise<string | 'too_large' | 'invalid'> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
    return 'too_large';
  }
  if (!req.body) {
    return '';
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        return 'too_large';
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks)
    );
  } catch {
    return 'invalid';
  }
}

export function createServer(opts: ServerOptions) {
  const mapping = parseMapping(opts.mapping);
  const now = opts.now ?? Date.now;
  const basePath = (opts.basePath ?? '').replace(/\/+$/, '');
  const nonces = createNonceCache(now);
  const schema = schemaOf(mapping);
  const idExpr = idExpression(mapping);
  const from = studentsFrom(mapping);
  const memberOnly = (sql: string) =>
    mapping.memberCondition ? `(${mapping.memberCondition}) AND ${sql}` : sql;

  const query = async (sql: string, params: unknown[]) =>
    (await opts.db.query(sql, params)).rows as Row[];

  function parseFilter(raw: unknown): FilterTree {
    const result = validateFilter(raw, schema);
    if (!result.ok) {
      throw badRequest(result.errors.join('; '));
    }
    return result.filter;
  }

  function parseBody<T>(zodSchema: z.ZodType<T>, body: unknown): T {
    const parsed = zodSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest();
    }
    return parsed.data;
  }

  async function count(body: unknown) {
    const { filter } = parseBody(zCountRequest, body);
    const { sql, params } = compileFilter(parseFilter(filter), mapping);
    const [row] = await query(
      `SELECT COUNT(*)::int AS count FROM ${from} WHERE ${memberOnly(sql)}`,
      params
    );
    return { count: Number(row?.count ?? 0) };
  }

  async function members(body: unknown) {
    const request = parseBody(zMembersRequest, body);
    const { sql, params } = compileFilter(parseFilter(request.filter), mapping);
    const after = request.cursor
      ? ` AND ${idExpr} > ${bind(params, decodeCursor(request.cursor))}`
      : '';
    const display = mapping.displayNameColumn
      ? studentColumn(mapping.displayNameColumn)
      : 'NULL';
    const rows = await query(
      `SELECT ${idExpr} AS id, ${display} AS display_name FROM ${from} WHERE ${memberOnly(sql)}${after} ORDER BY ${idExpr} LIMIT ${request.limit + 1}`,
      params
    );
    const page = rows.slice(0, request.limit);
    const last = page.at(-1);
    return {
      members: page.map((row) => {
        const name = row.display_name;
        const preview =
          request.fields === 'preview' && typeof name === 'string';
        return preview
          ? { id: String(row.id), displayName: maskName(name) }
          : { id: String(row.id) };
      }),
      nextCursor:
        rows.length > request.limit && last
          ? encodeCursor(String(last.id))
          : null,
    };
  }

  async function explain(body: unknown): Promise<Explanation> {
    const request = parseBody(zExplainRequest, body);
    const filter = parseFilter(request.filter);
    const params: unknown[] = [];
    const whole = compileFilter(filter, mapping);
    params.push(...whole.params);
    const leaves = collectConditions(filter);
    const columns = leaves.map(
      (leaf, index) => `${compileCondition(leaf, mapping, params)} AS c${index}`
    );
    const idPlaceholder = bind(params, request.id);
    const [row] = await query(
      `SELECT ${[`${whole.sql} AS matches`, ...columns].join(', ')} FROM ${from} WHERE ${memberOnly(`${idExpr} = ${idPlaceholder}`)}`,
      params
    );
    return {
      id: request.id,
      matches: row?.matches === true,
      conditions: leaves.map((leaf, index) => ({
        dimension: leaf.dimension,
        op: leaf.op,
        matched: row?.[`c${index}`] === true,
      })),
    };
  }

  async function dimensionValues(key: string, q: string, rawLimit: string) {
    const dimension = mapping.dimensions.find((d) => d.key === key);
    const limit = rawLimit === '' ? DEFAULT_VALUES_LIMIT : Number(rawLimit);
    const validLimit =
      Number.isInteger(limit) && limit >= 1 && limit <= MAX_PAGE_SIZE;
    if (!validLimit) {
      throw badRequest();
    }
    if (!(dimension && (dimension.values || dimension.staticValues))) {
      throw new HttpError(STATUS_NOT_FOUND, 'not_found');
    }
    const needle = q.toLowerCase();
    if (!dimension.values) {
      return (dimension.staticValues ?? [])
        .filter((v) => `${v.value} ${v.label}`.toLowerCase().includes(needle))
        .slice(0, limit);
    }
    const { table, valueColumn, labelColumn } = dimension.values;
    const params: unknown[] = [];
    const label = quote(labelColumn ?? valueColumn);
    const pattern = bind(params, `%${q.replace(/[\\%_]/g, '\\$&')}%`);
    const rows = await query(
      `SELECT ${quote(valueColumn)}::text AS value, ${label}::text AS label FROM ${quote(table)} WHERE ${label}::text ILIKE ${pattern} ORDER BY ${label}::text LIMIT ${limit}`,
      params
    );
    return rows.map((row) => ({
      value: String(row.value),
      label: String(row.label),
    }));
  }

  // Allow-listed select: only columns the mapping names ever leave the database.
  async function loadStudents(ids: string[]): Promise<Map<string, Row>> {
    const { contact } = mapping;
    const columns = [`${idExpr} AS id`];
    const optional: [string, string | undefined][] = [
      ['email', contact.emailColumn],
      ['email_verified', contact.emailVerifiedColumn],
      ['phone', contact.phoneColumn],
      ['suppressed', contact.suppressedColumn],
      ['consent_whatsapp', contact.consent?.whatsapp],
      ['consent_sms', contact.consent?.smsPromotional],
    ];
    for (const [alias, column] of optional) {
      if (column) {
        columns.push(`${studentColumn(column)} AS ${alias}`);
      }
    }
    Object.values(contact.traits).forEach((column, index) => {
      columns.push(`${studentColumn(column)} AS trait_${index}`);
    });
    const params: unknown[] = [];
    const rows = await query(
      `SELECT ${columns.join(', ')} FROM ${from} WHERE ${idExpr} IN (${bindList(params, ids)})`,
      params
    );
    return new Map(rows.map((row) => [String(row.id), row]));
  }

  async function loadDevices(ids: string[]) {
    const devices = new Map<string, { token: string; platform: string }[]>();
    if (!mapping.devices) {
      return devices;
    }
    const d = mapping.devices;
    const params: unknown[] = [];
    const active = d.activeColumn
      ? ` AND ${quote(d.activeColumn)} IS TRUE`
      : '';
    const rows = await query(
      `SELECT ${quote(d.studentColumn)}::text AS id, ${quote(d.tokenColumn)} AS token, ${quote(d.platformColumn)} AS platform FROM ${quote(d.table)} WHERE ${quote(d.studentColumn)}::text IN (${bindList(params, ids)})${active} AND ${quote(d.tokenColumn)} IS NOT NULL AND ${quote(d.tokenColumn)} <> ''`,
      params
    );
    for (const row of rows) {
      const list = devices.get(String(row.id)) ?? [];
      list.push({ token: String(row.token), platform: String(row.platform) });
      devices.set(String(row.id), list);
    }
    return devices;
  }

  function traitsOf(row: Row): Record<string, string | number | boolean> {
    const traits: Record<string, string | number | boolean> = {};
    Object.keys(mapping.contact.traits).forEach((key, index) => {
      const value = row[`trait_${index}`];
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        traits[key] = value;
      }
    });
    return traits;
  }

  function consentOf(row: Row): LookupEntry['consent'] {
    const consent: NonNullable<LookupEntry['consent']> = {};
    if (typeof row.consent_whatsapp === 'boolean') {
      consent.whatsapp = row.consent_whatsapp;
    }
    if (typeof row.consent_sms === 'boolean') {
      consent.sms_promotional = row.consent_sms;
    }
    return Object.keys(consent).length > 0 ? consent : undefined;
  }

  function entryFor(
    id: string,
    row: Row | undefined,
    channel: LookupChannel,
    devices: { token: string; platform: string }[]
  ): LookupEntry {
    if (!row) {
      return { id, status: 'not_found' };
    }
    if (row.suppressed === true) {
      return { id, status: 'suppressed' };
    }
    const unreachable = (reason: string): LookupEntry => ({
      id,
      status: 'unreachable',
      reason,
    });
    const base: LookupEntry = { id, status: 'ok', traits: traitsOf(row) };
    const consent = consentOf(row);
    if (consent) {
      base.consent = consent;
    }
    if (channel === 'email') {
      const email = typeof row.email === 'string' ? row.email : '';
      if (email === '') {
        return unreachable('no_email');
      }
      // Without a verified column the mapping asserts every stored email is verified.
      const verified =
        mapping.contact.emailVerifiedColumn === undefined ||
        row.email_verified === true;
      return verified ? { ...base, email } : unreachable('unverified_email');
    }
    if (channel === 'sms' || channel === 'whatsapp') {
      const phone = digitsOf(typeof row.phone === 'string' ? row.phone : '');
      const valid =
        phone.length >= MIN_PHONE_DIGITS && phone.length <= MAX_PHONE_DIGITS;
      return valid ? { ...base, phone } : unreachable('no_valid_phone');
    }
    if (channel === 'push') {
      return devices.length > 0
        ? { ...base, devices }
        : unreachable('no_active_device');
    }
    return base;
  }

  async function lookup(body: unknown) {
    const request = parseBody(zLookupRequest, body);
    const ids = [...new Set(request.ids)];
    if (ids.length === 0) {
      return { entries: [] };
    }
    const students = await loadStudents(ids);
    const devices =
      request.channel === 'push' ? await loadDevices(ids) : new Map();
    return {
      entries: ids.map((id) =>
        entryFor(id, students.get(id), request.channel, devices.get(id) ?? [])
      ),
    };
  }

  async function resolve(body: unknown) {
    const { inputs: raw } = parseBody(zResolveRequest, body);
    const inputs = [...new Set(raw.map((i) => i.trim()).filter(Boolean))];
    const { contact } = mapping;
    const byEmail = new Map<string, string[]>();
    const byPhone = new Map<string, string[]>();
    const emails = inputs
      .filter((i) => i.includes('@'))
      .map((i) => i.toLowerCase());
    const phones = inputs
      .filter((i) => !i.includes('@'))
      .map(digitsOf)
      .filter((p) => p.length >= MIN_PHONE_DIGITS);
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (contact.emailColumn && emails.length > 0) {
      clauses.push(
        `lower(${studentColumn(contact.emailColumn)}) IN (${bindList(params, emails)})`
      );
    }
    if (contact.phoneColumn && phones.length > 0) {
      clauses.push(
        `regexp_replace(${studentColumn(contact.phoneColumn)}, '\\D', '', 'g') IN (${bindList(params, phones)})`
      );
    }
    const rows =
      clauses.length > 0
        ? await query(
            `SELECT ${idExpr} AS id, ${contact.emailColumn ? studentColumn(contact.emailColumn) : 'NULL'} AS email, ${contact.phoneColumn ? studentColumn(contact.phoneColumn) : 'NULL'} AS phone FROM ${from} WHERE ${clauses.join(' OR ')} ORDER BY ${idExpr}`,
            params
          )
        : [];
    for (const row of rows) {
      const id = String(row.id);
      if (typeof row.email === 'string') {
        const key = row.email.toLowerCase();
        byEmail.set(key, [...(byEmail.get(key) ?? []), id]);
      }
      if (typeof row.phone === 'string') {
        const key = digitsOf(row.phone);
        byPhone.set(key, [...(byPhone.get(key) ?? []), id]);
      }
    }
    const matches: { input: string; id: string }[] = [];
    const unmatched: string[] = [];
    for (const input of inputs) {
      const found = input.includes('@')
        ? byEmail.get(input.toLowerCase())
        : byPhone.get(digitsOf(input));
      if (found) {
        matches.push(...found.map((id) => ({ input, id })));
      } else {
        unmatched.push(input);
      }
    }
    return { matches, unmatched };
  }

  async function route(
    method: string,
    path: string,
    search: URLSearchParams,
    rawBody: string
  ): Promise<unknown> {
    const readBody = (): unknown => {
      try {
        return JSON.parse(rawBody);
      } catch {
        throw badRequest();
      }
    };
    if (method === 'GET' && path === '/schema') {
      return schema;
    }
    const valuesMatch = /^\/dimensions\/([^/]+)\/values$/.exec(path);
    if (method === 'GET' && valuesMatch) {
      const values = await dimensionValues(
        decodeKey(valuesMatch[1] ?? ''),
        search.get('q') ?? '',
        search.get('limit') ?? ''
      );
      return { values };
    }
    if (method === 'POST') {
      const handlers: Record<string, (body: unknown) => Promise<unknown>> = {
        '/audience/count': count,
        '/audience/members': members,
        '/audience/explain': explain,
        '/members/lookup': lookup,
        '/members/resolve': resolve,
      };
      const handler = handlers[path];
      if (handler) {
        return handler(readBody());
      }
    }
    throw new HttpError(STATUS_NOT_FOUND, 'not_found');
  }

  async function fetchHandler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const read = await readBodyCapped(req);
    if (read === 'too_large') {
      return json({ error: 'payload_too_large' }, STATUS_TOO_LARGE);
    }
    if (read === 'invalid') {
      return json({ error: 'invalid request' }, STATUS_BAD_REQUEST);
    }
    const rawBody = read;
    // Deny by default: nothing below runs unless the signature verifies.
    const verdict = await verifyRequest({
      headers: req.headers,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      body: rawBody,
      keys: opts.keys,
      now: Math.floor(now() / MS_PER_SECOND),
      nonces,
    }).catch(() => ({ ok: false as const }));
    if (!verdict.ok) {
      return json({ error: 'unauthorized' }, STATUS_UNAUTHORIZED);
    }
    const inBase =
      basePath === '' ||
      url.pathname === basePath ||
      url.pathname.startsWith(`${basePath}/`);
    if (!inBase) {
      return json({ error: 'not_found' }, STATUS_NOT_FOUND);
    }
    try {
      const result = await route(
        req.method,
        url.pathname.slice(basePath.length),
        url.searchParams,
        rawBody
      );
      return json(result);
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.message }, error.status);
      }
      // Never log: database errors can carry row values.
      return json({ error: 'internal' }, STATUS_INTERNAL);
    }
  }

  return { fetch: fetchHandler };
}
