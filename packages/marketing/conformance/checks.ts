import { createBreaker } from '../src/audience/breaker';
import {
  type Condition,
  type FilterTree,
  type LookupChannel,
  MAX_ID_CONDITION_VALUES,
  MAX_LOOKUP_IDS,
  MAX_PAGE_SIZE,
  MAX_RESOLVE_INPUTS,
  RESERVED_ID_DIMENSION,
  type Schema,
} from '../src/audience/contract';
import { createHttpSource } from '../src/audience/http-source';
import type { createSourceLimiter } from '../src/audience/limiter';
import { newNonce, signRequest } from '../src/audience/signing';
import type { AudienceSource } from '../src/audience/source';
import dataset from './seed/dataset.json';
import expected from './seed/expected.json';

export const COUNT_WARN_MS = 2000;
export const PAGE_WARN_MS = 2000;
export const LOOKUP_WARN_MS = 1000;
const MS_PER_SECOND = 1000;
const STALE_OFFSET_SECONDS = 120;
const STATUS_OK = 200;
const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHORIZED = 401;
const STATUS_CLIENT_ERROR_END = 500;
const NOT_A_VALIDATION_REJECTION = new Set([401, 403, 404, 405]);
const PREVIEW_PAGE = 5;
const MISSING_ID = '9999';
// Quotes, a statement break, a comment and non-ASCII text; NUL is left out because Postgres rejects it in any text parameter.
const INJECTION_STRINGS = [
  "' OR '1'='1",
  '1; DROP TABLE users; --',
  '") OR 1=1 /*',
  '%_\\',
  'ü名前😀‮',
];
const REQUIRED_DIMENSIONS = [
  'university',
  'course',
  'semester',
  'signup_date',
  'purchase_status',
];

export interface Target {
  baseUrl: string;
  keyId: string;
  secret: string;
  fetch?: typeof fetch;
}

export class CheckFailure extends Error {}

function fail(detail: string): never {
  throw new CheckFailure(detail);
}

// The suite is a one-shot client: no shared Redis slots, and a breaker that never opens.
const unlimited = {
  acquire: async () => async () => undefined,
} as ReturnType<typeof createSourceLimiter>;

interface RawOptions {
  auth?: 'valid' | 'none' | 'wrong_secret' | 'unknown_key';
  timestamp?: number;
  nonce?: string;
  sendBody?: string;
}

export function createContext(
  target: Target,
  clock: () => number,
  warn: (check: string, detail: string) => void
) {
  const doFetch = target.fetch ?? fetch;
  const base = new URL(target.baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const source: AudienceSource = createHttpSource({
    baseUrl: target.baseUrl,
    keyId: target.keyId,
    secret: target.secret,
    fetch: doFetch,
    limiter: unlimited,
    breaker: createBreaker({
      failureThreshold: Number.MAX_SAFE_INTEGER,
      openMs: 0,
    }),
    sleep: async () => undefined,
  });

  async function raw(
    method: 'GET' | 'POST',
    route: string,
    payload?: unknown,
    options: RawOptions = {}
  ): Promise<{ status: number; json: unknown }> {
    const path = `${basePath}${route}`;
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const auth = options.auth ?? 'valid';
    const headers: Record<string, string> =
      auth === 'none'
        ? {}
        : signRequest({
            method,
            path,
            body,
            keyId:
              auth === 'unknown_key' ? `${target.keyId}-unknown` : target.keyId,
            secret:
              auth === 'wrong_secret'
                ? `${target.secret}-wrong`
                : target.secret,
            timestamp:
              options.timestamp ?? Math.floor(Date.now() / MS_PER_SECOND),
            nonce: options.nonce ?? newNonce(),
          });
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
    }
    const res = await doFetch(`${base.origin}${path}`, {
      method,
      headers,
      body: method === 'POST' ? (options.sendBody ?? body) : undefined,
      redirect: 'manual',
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  }

  let schemaPromise: Promise<Schema> | undefined;
  const schema = () => {
    schemaPromise ??= source.schema();
    return schemaPromise;
  };

  // Dataset values are numbers or strings; send each in the type the target declared.
  async function typed(filter: FilterTree): Promise<FilterTree> {
    const declared = new Map(
      (await schema()).dimensions.map((d) => [d.key, d.type])
    );
    const convert = (node: FilterTree): FilterTree => {
      if ('children' in node) {
        return { op: node.op, children: node.children.map(convert) };
      }
      const type = declared.get(node.dimension);
      const values = node.values.map((value) => {
        if (type === 'number') {
          return Number(value);
        }
        return type === 'string' ? String(value) : value;
      });
      return { ...node, values } as Condition;
    };
    return convert(filter);
  }

  async function timed<T>(
    check: string,
    limitMs: number,
    label: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const started = clock();
    const result = await fn();
    const took = clock() - started;
    if (took > limitMs) {
      warn(
        check,
        `${label} took ${Math.round(took)} ms (target ${limitMs} ms)`
      );
    }
    return result;
  }

  async function pageAll(filter: FilterTree, limit: number, maxPages: number) {
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      if (pages.length >= maxPages) {
        fail(`paging did not end after ${maxPages} pages`);
      }
      const page = await source.members({
        filter: await typed(filter),
        cursor,
        limit,
        fields: 'id',
      });
      pages.push(page.members.map((m) => m.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return pages;
  }

  function rejected(check: string, label: string, status: number) {
    const isClientError =
      status >= STATUS_BAD_REQUEST && status < STATUS_CLIENT_ERROR_END;
    // A correctly signed request to a contract route must reach validation, so these do not count as a rejection.
    if (!isClientError || NOT_A_VALIDATION_REJECTION.has(status)) {
      fail(`${label}: expected a 4xx validation rejection, got ${status}`);
    }
    if (status !== STATUS_BAD_REQUEST) {
      warn(
        'rejection_status',
        `${check}: ${label} answered ${status}, 400 expected`
      );
    }
  }

  return { source, raw, schema, typed, timed, pageAll, rejected, warn };
}

type Context = ReturnType<typeof createContext>;

const countFilter = (name: string): FilterTree => {
  const entry = expected.counts.find((c) => c.name === name);
  return (entry?.filter ??
    fail(`expected.json has no filter ${name}`)) as FilterTree;
};
const ALL = () => countFilter('all');
const studentsById = new Map(dataset.students.map((s) => [s.id, s]));
const sortByValue = (items: { value: string; label: string }[]) =>
  [...items].sort((a, b) => a.value.localeCompare(b.value));
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const digits = (value: string) => value.replace(/\D/g, '');

async function expect401(label: string, request: Promise<{ status: number }>) {
  const { status } = await request;
  if (status !== STATUS_UNAUTHORIZED) {
    fail(`${label}: expected 401, got ${status}`);
  }
}

function checkOkEntry(
  entry: Awaited<ReturnType<AudienceSource['lookup']>>[number],
  channel: LookupChannel
): string | undefined {
  const student = studentsById.get(entry.id);
  if (!student) {
    return `id ${entry.id} is ok but not in the dataset`;
  }
  if (entry.traits?.firstName !== student.firstName) {
    return `id ${entry.id}: traits.firstName missing or wrong`;
  }
  const leaks =
    (channel !== 'email' && entry.email !== undefined) ||
    (channel !== 'sms' &&
      channel !== 'whatsapp' &&
      entry.phone !== undefined) ||
    (channel !== 'push' && entry.devices !== undefined);
  if (leaks) {
    return `id ${entry.id}: returns contact fields the ${channel} channel does not need`;
  }
  if (channel === 'email' && entry.email !== student.email) {
    return `id ${entry.id}: email missing or wrong`;
  }
  const wantsPhone = channel === 'sms' || channel === 'whatsapp';
  if (wantsPhone && digits(entry.phone ?? '') !== student.phone) {
    return `id ${entry.id}: phone missing or not in international digits`;
  }
  if (channel === 'push') {
    const want = dataset.devices
      .filter((d) => d.studentId === entry.id && d.active && d.token)
      .map((d) => d.token)
      .sort();
    const got = (entry.devices ?? []).map((d) => d.token).sort();
    if (!same(want, got)) {
      return `id ${entry.id}: devices are not exactly the active tokens`;
    }
  }
  return undefined;
}

export const checks: { name: string; run: (ctx: Context) => Promise<void> }[] =
  [
    {
      name: 'schema',
      async run(ctx) {
        const { dimensions } = await ctx.schema();
        const byKey = new Map(dimensions.map((d) => [d.key, d]));
        const missing = REQUIRED_DIMENSIONS.filter((key) => !byKey.has(key));
        if (missing.length > 0) {
          fail(`missing dimensions: ${missing.join(', ')}`);
        }
        if (byKey.has(RESERVED_ID_DIMENSION)) {
          fail('the reserved id dimension must not be declared');
        }
        const course = byKey.get('course');
        if (!(course?.multiValued && course.valuesListable)) {
          fail('course must be multiValued and valuesListable');
        }
        if (!byKey.get('university')?.valuesListable) {
          fail('university must be valuesListable');
        }
        if (byKey.get('signup_date')?.type !== 'date') {
          fail('signup_date must be of type date');
        }
        if (byKey.get('purchase_status')?.type !== 'string') {
          fail('purchase_status must be of type string');
        }
      },
    },
    {
      name: 'dimension_values',
      async run(ctx) {
        for (const want of expected.values) {
          const got = await ctx.source.dimensionValues(
            want.dimension,
            want.q,
            want.limit
          );
          if (!same(sortByValue(got), sortByValue(want.values))) {
            fail(`${want.dimension} values for a search differ from expected`);
          }
        }
        const one = await ctx.source.dimensionValues('course', '', 1);
        if (one.length > 1) {
          fail(`limit=1 returned ${one.length} values`);
        }
      },
    },
    {
      name: 'counts',
      async run(ctx) {
        const wrong: string[] = [];
        for (const { name, filter, count } of expected.counts) {
          const typedFilter = await ctx.typed(filter as FilterTree);
          const got = await ctx.timed(
            'service_level_count',
            COUNT_WARN_MS,
            `count ${name}`,
            () => ctx.source.count(typedFilter)
          );
          if (got.count !== count) {
            wrong.push(`${name}: expected ${count}, got ${got.count}`);
          }
        }
        if (wrong.length > 0) {
          fail(wrong.join('; '));
        }
      },
    },
    {
      name: 'count_matches_pages',
      async run(ctx) {
        const filter = await ctx.typed(ALL());
        const { count } = await ctx.source.count(filter);
        const first = await ctx.timed(
          'service_level_page',
          PAGE_WARN_MS,
          `a page of ${MAX_PAGE_SIZE}`,
          () =>
            ctx.source.members({ filter, limit: MAX_PAGE_SIZE, fields: 'id' })
        );
        const rest = first.nextCursor
          ? (await ctx.pageAll(ALL(), MAX_PAGE_SIZE, count)).flat()
          : first.members.map((m) => m.id);
        if (rest.length !== count) {
          fail(`count is ${count} but ${rest.length} ids were paged out`);
        }
      },
    },
    {
      name: 'paging_no_duplicates',
      async run(ctx) {
        const ids = (
          await ctx.pageAll(ALL(), 2, dataset.students.length)
        ).flat();
        if (new Set(ids).size !== ids.length) {
          fail('an id appeared on more than one page');
        }
        const ordered = [...ids].sort();
        if (!same(ids, ordered)) {
          fail('ids are not in ascending order compared as text');
        }
      },
    },
    {
      name: 'page_sequences',
      async run(ctx) {
        for (const run of expected.pages) {
          const pages = await ctx.pageAll(
            run.filter as FilterTree,
            run.limit,
            run.pages.length + 1
          );
          if (!same(pages.flat(), run.pages.flat())) {
            fail(
              `${run.name}: concatenated pages differ from the sorted id list`
            );
          }
          if (!same(pages, run.pages)) {
            fail(`${run.name}: page boundaries differ at limit ${run.limit}`);
          }
        }
      },
    },
    {
      name: 'multi_course_once',
      async run(ctx) {
        const { id, filter, count } = expected.multiCourse;
        const got = await ctx.source.count(
          await ctx.typed(filter as FilterTree)
        );
        if (got.count !== count) {
          fail(`expected ${count} distinct students, got ${got.count}`);
        }
        const ids = (
          await ctx.pageAll(filter as FilterTree, MAX_PAGE_SIZE, count)
        ).flat();
        const seen = ids.filter((member) => member === id).length;
        if (seen !== 1) {
          fail(`the multi-course student ${id} was paged ${seen} times`);
        }
      },
    },
    {
      name: 'preview_masked',
      async run(ctx) {
        const page = await ctx.source.members({
          filter: await ctx.typed(ALL()),
          limit: PREVIEW_PAGE,
          fields: 'preview',
        });
        for (const member of page.members) {
          const student = studentsById.get(member.id);
          const name = member.displayName ?? '';
          const leaked =
            student &&
            (name.includes(student.firstName) ||
              name.includes(student.lastName));
          if (leaked) {
            fail(`id ${member.id}: preview shows an unmasked name`);
          }
        }
      },
    },
    {
      name: 'explain',
      async run(ctx) {
        for (const want of expected.explanations) {
          const got = await ctx.source.explain(
            await ctx.typed(want.filter as FilterTree),
            want.id
          );
          const conditions = got.conditions.map(
            ({ dimension, op, matched }) => ({
              dimension,
              op,
              matched,
            })
          );
          if (got.id !== want.id || got.matches !== want.matches) {
            fail(
              `${want.name} for ${want.id}: expected matches=${want.matches}`
            );
          }
          if (!same(conditions, want.conditions)) {
            fail(
              `${want.name} for ${want.id}: conditions differ from expected`
            );
          }
        }
      },
    },
    {
      name: 'lookup_entries',
      async run(ctx) {
        const [a = '', b = ''] = dataset.students.map((s) => s.id);
        const res = await ctx.raw('POST', '/members/lookup', {
          ids: [a, a, b, MISSING_ID],
          channel: 'none',
        });
        const entries = (res.json as { entries?: { id: string }[] })?.entries;
        if (res.status !== STATUS_OK || !Array.isArray(entries)) {
          fail(`lookup answered ${res.status} without an entries array`);
        }
        const ids = (entries ?? []).map((e) => e.id).sort();
        if (!same(ids, [a, b, MISSING_ID].sort())) {
          fail(
            'lookup must return exactly one entry per distinct requested id'
          );
        }
        const empty = await ctx.raw('POST', '/members/lookup', {
          ids: [],
          channel: 'none',
        });
        const emptyEntries = (empty.json as { entries?: unknown[] })?.entries;
        if (empty.status !== STATUS_OK || emptyEntries?.length !== 0) {
          fail('a lookup of no ids must answer 200 with no entries');
        }
      },
    },
    {
      name: 'lookup_statuses',
      async run(ctx) {
        for (const want of expected.lookups) {
          const channel = want.channel as LookupChannel;
          const entries = await ctx.source.lookup(want.ids, channel);
          const byId = new Map(entries.map((e) => [e.id, e]));
          for (const wanted of want.entries) {
            const got = byId.get(wanted.id);
            if (got?.status !== wanted.status) {
              fail(
                `${channel} ${wanted.id}: expected ${wanted.status}, got ${got?.status}`
              );
            }
            if (wanted.status === 'unreachable' && !got?.reason) {
              fail(`${channel} ${wanted.id}: unreachable without a reason`);
            }
            const wantedReason = 'reason' in wanted ? wanted.reason : undefined;
            // Reason strings are not pinned by the contract, so the reference vocabulary is advisory.
            if (wantedReason && got?.reason !== wantedReason) {
              ctx.warn(
                'lookup_reasons',
                `${channel} ${wanted.id}: reason ${got?.reason ?? 'none'}, reference says ${wantedReason}`
              );
            }
            const problem =
              got?.status === 'ok' ? checkOkEntry(got, channel) : undefined;
            if (problem) {
              fail(`${channel} ${problem}`);
            }
          }
        }
        const many = [
          ...dataset.students.map((s) => s.id),
          ...Array.from(
            { length: MAX_LOOKUP_IDS - dataset.students.length },
            (_, i) => `${MISSING_ID}${i}`
          ),
        ];
        await ctx.timed(
          'service_level_lookup',
          LOOKUP_WARN_MS,
          `a lookup of ${many.length} ids`,
          () => ctx.source.lookup(many, 'email')
        );
      },
    },
    {
      name: 'resolve',
      async run(ctx) {
        const want = expected.resolve;
        const res = await ctx.raw('POST', '/members/resolve', {
          inputs: want.inputs,
        });
        const body = res.json as {
          matches?: Record<string, unknown>[];
          unmatched?: unknown[];
        };
        if (res.status !== STATUS_OK || !body) {
          fail(`resolve answered ${res.status}`);
        }
        const extraTopLevel = Object.keys(body).filter(
          (k) => k !== 'matches' && k !== 'unmatched'
        );
        const extraMatchFields = (body.matches ?? []).some((m) =>
          Object.keys(m).some((k) => k !== 'input' && k !== 'id')
        );
        if (extraTopLevel.length > 0 || extraMatchFields) {
          fail('resolve must return ids only (input, id, unmatched)');
        }
        const key = (m: Record<string, unknown>) => `${m.input}=>${m.id}`;
        const gotMatches = (body.matches ?? []).map(key).sort();
        const wantMatches = want.matches.map(key).sort();
        if (!same(gotMatches, wantMatches)) {
          fail('resolve matches differ from expected');
        }
        if (
          !same([...(body.unmatched ?? [])].sort(), [...want.unmatched].sort())
        ) {
          fail('resolve unmatched inputs differ from expected');
        }
      },
    },
    {
      name: 'security_no_key',
      run: (ctx) =>
        expect401(
          'unsigned GET /schema',
          ctx.raw('GET', '/schema', undefined, { auth: 'none' })
        ),
    },
    {
      name: 'security_wrong_key',
      async run(ctx) {
        await expect401(
          'wrong secret',
          ctx.raw('GET', '/schema', undefined, { auth: 'wrong_secret' })
        );
        await expect401(
          'unknown key id',
          ctx.raw('GET', '/schema', undefined, { auth: 'unknown_key' })
        );
      },
    },
    {
      name: 'security_tampered_body',
      run: (ctx) =>
        expect401(
          'body changed after signing',
          ctx.raw(
            'POST',
            '/audience/count',
            { filter: ALL() },
            { sendBody: JSON.stringify({ filter: countFilter('purchased') }) }
          )
        ),
    },
    {
      name: 'security_stale_timestamp',
      async run(ctx) {
        const nowSeconds = Math.floor(Date.now() / MS_PER_SECOND);
        await expect401(
          'timestamp 120 s old',
          ctx.raw('GET', '/schema', undefined, {
            timestamp: nowSeconds - STALE_OFFSET_SECONDS,
          })
        );
        await expect401(
          'timestamp 120 s ahead',
          ctx.raw('GET', '/schema', undefined, {
            timestamp: nowSeconds + STALE_OFFSET_SECONDS,
          })
        );
      },
    },
    {
      name: 'security_replayed_nonce',
      async run(ctx) {
        const nonce = newNonce();
        const first = await ctx.raw('GET', '/schema', undefined, { nonce });
        if (first.status !== STATUS_OK) {
          fail(`a fresh signed request answered ${first.status}`);
        }
        await expect401(
          'the same nonce again',
          ctx.raw('GET', '/schema', undefined, { nonce })
        );
      },
    },
    {
      name: 'undeclared_dimension',
      async run(ctx) {
        const { status } = await ctx.raw('POST', '/audience/count', {
          filter: { dimension: 'password_hash', op: 'eq', values: ['x'] },
        });
        ctx.rejected(
          'undeclared_dimension',
          'a filter on an undeclared column',
          status
        );
      },
    },
    {
      name: 'limit_page',
      async run(ctx) {
        const { status } = await ctx.raw('POST', '/audience/members', {
          filter: await ctx.typed(ALL()),
          limit: MAX_PAGE_SIZE + 1,
          fields: 'id',
        });
        ctx.rejected(
          'limit_page',
          `a page limit of ${MAX_PAGE_SIZE + 1}`,
          status
        );
      },
    },
    {
      name: 'limit_lookup',
      async run(ctx) {
        const { status } = await ctx.raw('POST', '/members/lookup', {
          ids: Array.from({ length: MAX_LOOKUP_IDS + 1 }, (_, i) => String(i)),
          channel: 'none',
        });
        ctx.rejected(
          'limit_lookup',
          `${MAX_LOOKUP_IDS + 1} lookup ids`,
          status
        );
      },
    },
    {
      name: 'limit_resolve',
      async run(ctx) {
        const { status } = await ctx.raw('POST', '/members/resolve', {
          inputs: Array.from(
            { length: MAX_RESOLVE_INPUTS + 1 },
            (_, i) => `limit${i}@example.test`
          ),
        });
        ctx.rejected(
          'limit_resolve',
          `${MAX_RESOLVE_INPUTS + 1} resolve inputs`,
          status
        );
      },
    },
    {
      name: 'limit_id_values',
      async run(ctx) {
        const { status } = await ctx.raw('POST', '/audience/count', {
          filter: {
            dimension: RESERVED_ID_DIMENSION,
            op: 'in',
            values: Array.from(
              { length: MAX_ID_CONDITION_VALUES + 1 },
              (_, i) => String(i)
            ),
          },
        });
        ctx.rejected(
          'limit_id_values',
          `an id condition with ${MAX_ID_CONDITION_VALUES + 1} values`,
          status
        );
      },
    },
    {
      name: 'filter_depth',
      async run(ctx) {
        const leaf = await ctx.typed(countFilter('university_eq'));
        const depth4 = {
          op: 'and',
          children: [{ op: 'or', children: [{ op: 'and', children: [leaf] }] }],
        };
        const { status } = await ctx.raw('POST', '/audience/count', {
          filter: depth4,
        });
        ctx.rejected('filter_depth', 'a filter nested 4 deep', status);
      },
    },
    {
      name: 'injection',
      async run(ctx) {
        for (const [index, value] of INJECTION_STRINGS.entries()) {
          const label = `injection string #${index + 1}`;
          const attempts: [
            string,
            Promise<{ status: number; json: unknown }>,
          ][] = [
            [
              'count on purchase_status',
              ctx.raw('POST', '/audience/count', {
                filter: {
                  dimension: 'purchase_status',
                  op: 'eq',
                  values: [value],
                },
              }),
            ],
            [
              'count on id',
              ctx.raw('POST', '/audience/count', {
                filter: {
                  dimension: RESERVED_ID_DIMENSION,
                  op: 'in',
                  values: [value],
                },
              }),
            ],
            [
              'explain id',
              ctx.raw('POST', '/audience/explain', {
                filter: ALL(),
                id: value,
              }),
            ],
            [
              'lookup id',
              ctx.raw('POST', '/members/lookup', {
                ids: [value],
                channel: 'email',
              }),
            ],
            [
              'resolve input',
              ctx.raw('POST', '/members/resolve', { inputs: [value] }),
            ],
            [
              'values search',
              ctx.raw(
                'GET',
                `/dimensions/university/values?q=${encodeURIComponent(value)}&limit=5`
              ),
            ],
          ];
          for (const [what, request] of attempts) {
            const { status, json } = await request;
            if (status >= STATUS_CLIENT_ERROR_END) {
              fail(`${label} in ${what}: answered ${status}`);
            }
            const count = (json as { count?: unknown })?.count;
            if (
              status === STATUS_OK &&
              what.startsWith('count') &&
              count !== 0
            ) {
              fail(`${label} in ${what}: matched students`);
            }
          }
        }
      },
    },
  ];
