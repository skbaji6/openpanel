import {
  type Condition,
  type Explanation,
  type FilterTree,
  type LookupChannel,
  type LookupEntry,
  MAX_LOOKUP_IDS,
  MAX_PAGE_SIZE,
  MAX_RESOLVE_INPUTS,
  RESERVED_ID_DIMENSION,
  type Schema,
} from './contract';
import { SourceProtocolError, SourceUnavailableError } from './errors';
import {
  normalizeResolveInputs,
  validateFilter,
  validateFilterStructure,
} from './filter';
import type { AudienceSource } from './source';

type Scalar = string | number | boolean;

export interface FakeMember {
  id: string;
  values: Record<string, Scalar | (string | number)[]>;
  displayName?: string;
  contact?: { phone?: string; email?: string };
  suppressed?: boolean;
  // Forces a channel unreachable with this reason, e.g. unverified_email.
  unreachable?: Partial<Record<LookupChannel, string>>;
  traits?: Record<string, string>;
  devices?: { token: string; platform: string }[];
  consent?: { whatsapp?: boolean; sms_promotional?: boolean };
}

interface FakeCall {
  method: string;
  filter?: FilterTree;
  cursor?: string;
  limit?: number;
}

interface FakeSourceOptions {
  members: FakeMember[];
  schema?: Schema;
  pageDelayMs?: number;
  down?: () => boolean;
  // Serves this many members pages, then fails every later one as unavailable.
  failAfterPages?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const MIN_PHONE_DIGITS = 8;
const MAX_PHONE_DIGITS = 15;
const NATIONAL_NUMBER_DIGITS = 10;
const COUNTRY_CODE = '91';

function valuesOf(member: FakeMember, dimension: string): Scalar[] {
  if (dimension === RESERVED_ID_DIMENSION) {
    return [member.id];
  }
  const raw = member.values[dimension];
  if (raw === undefined) {
    return [];
  }
  return Array.isArray(raw) ? raw : [raw];
}

// A stored 3 matches the filter value "3": filter values take the type of the stored value.
function coerce(filterValue: Scalar, stored: Scalar): Scalar {
  if (typeof stored === 'number') {
    return Number(filterValue);
  }
  if (typeof stored === 'boolean') {
    return filterValue === true || filterValue === 'true';
  }
  return String(filterValue);
}

function matchesCondition(member: FakeMember, condition: Condition): boolean {
  const present = valuesOf(member, condition.dimension);
  const { op, values } = condition;
  const first = values[0] as Scalar;
  const second = values[1] as Scalar;
  const same = (value: Scalar, filterValue: Scalar) =>
    value === coerce(filterValue, value);
  const listed = (value: Scalar) =>
    values.some((filterValue) => same(value, filterValue));
  switch (op) {
    case 'eq':
      return present.some((value) => same(value, first));
    case 'in':
      return present.some(listed);
    case 'not_in':
      // A member with no value for the dimension is not in the list.
      return !present.some(listed);
    case 'gt':
      return present.some((value) => value > coerce(first, value));
    case 'lt':
      return present.some((value) => value < coerce(first, value));
    case 'between':
      return present.some(
        (value) =>
          value >= coerce(first, value) && value <= coerce(second, value)
      );
    case 'exists':
      return present.length > 0;
    default:
      return false;
  }
}

function matches(member: FakeMember, filter: FilterTree): boolean {
  if ('children' in filter) {
    const test = (child: FilterTree) => matches(member, child);
    return filter.op === 'and'
      ? filter.children.every(test)
      : filter.children.some(test);
  }
  return matchesCondition(member, filter);
}

function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
}

function nationalDigits(value: string): string {
  const digits = digitsOf(value);
  return digits.length > NATIONAL_NUMBER_DIGITS &&
    digits.startsWith(COUNTRY_CODE)
    ? digits.slice(COUNTRY_CODE.length)
    : digits;
}

function leaves(filter: FilterTree): Condition[] {
  return 'children' in filter ? filter.children.flatMap(leaves) : [filter];
}

function contactMatches(member: FakeMember, input: string): boolean {
  if (input.includes('@')) {
    return member.contact?.email?.trim().toLowerCase() === input.toLowerCase();
  }
  const phone = member.contact?.phone;
  return phone !== undefined && nationalDigits(phone) === nationalDigits(input);
}

function entryFor(
  id: string,
  member: FakeMember | undefined,
  channel: LookupChannel
): LookupEntry {
  if (!member) {
    return { id, status: 'not_found' };
  }
  if (member.suppressed) {
    return { id, status: 'suppressed' };
  }
  const unreachable = (reason: string): LookupEntry => ({
    id,
    status: 'unreachable',
    reason,
  });
  const forced = member.unreachable?.[channel];
  if (forced) {
    return unreachable(forced);
  }
  const entry: LookupEntry = { id, status: 'ok' };
  if (member.traits) {
    entry.traits = member.traits;
  }
  if (member.consent) {
    entry.consent = member.consent;
  }
  if (channel === 'email') {
    if (!member.contact?.email) {
      return unreachable('no_email');
    }
    entry.email = member.contact.email;
  }
  if (channel === 'sms' || channel === 'whatsapp') {
    const phone = digitsOf(member.contact?.phone ?? '');
    if (phone.length < MIN_PHONE_DIGITS || phone.length > MAX_PHONE_DIGITS) {
      return unreachable('no_valid_phone');
    }
    entry.phone = phone;
  }
  if (channel === 'push') {
    if (!member.devices?.length) {
      return unreachable('no_active_device');
    }
    entry.devices = member.devices;
  }
  return entry;
}

function checkLimit(label: string, size: number, max: number) {
  if (size > max) {
    throw new SourceProtocolError(
      `fake_invalid_request: ${label} exceeds ${max}`
    );
  }
}

export function createFakeSource(opts: FakeSourceOptions) {
  // Byte order, as the reference service sorts ids with COLLATE "C".
  const sorted = [...opts.members].sort((a, b) =>
    a.id < b.id ? -1 : Number(a.id > b.id)
  );
  const visible = sorted.filter((member) => member.suppressed !== true);
  const calls: FakeCall[] = [];
  const now = opts.now ?? (() => performance.now());
  let timeMs = 0;
  let pagesServed = 0;

  async function run<T>(
    call: FakeCall,
    body: () => T | Promise<T>
  ): Promise<T> {
    calls.push(call);
    if (opts.down?.()) {
      throw new SourceUnavailableError('fake_down');
    }
    const started = now();
    try {
      return await body();
    } finally {
      timeMs += now() - started;
    }
  }

  async function waitForPage() {
    if (!opts.pageDelayMs) {
      return;
    }
    if (opts.sleep) {
      await opts.sleep(opts.pageDelayMs);
      // An injected sleep takes no real time, so the delay is counted explicitly.
      timeMs += opts.pageDelayMs;
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, opts.pageDelayMs));
  }

  function checkFilter(filter: FilterTree) {
    const verdict = opts.schema
      ? validateFilter(filter, opts.schema)
      : validateFilterStructure(filter);
    if (!verdict.ok) {
      throw new SourceProtocolError(
        `fake_invalid_filter: ${verdict.errors.join('; ')}`
      );
    }
  }

  const matching = (filter: FilterTree) =>
    visible.filter((member) => matches(member, filter));

  const source: AudienceSource = {
    schema: () =>
      run({ method: 'schema' }, () => opts.schema ?? { dimensions: [] }),
    dimensionValues: (key, q, limit) =>
      run({ method: 'dimensionValues', limit }, () => {
        const distinct = new Set<string>();
        for (const member of sorted) {
          for (const value of valuesOf(member, key)) {
            distinct.add(String(value));
          }
        }
        const needle = q.toLowerCase();
        return [...distinct]
          .filter((value) => value.toLowerCase().includes(needle))
          .slice(0, limit)
          .map((value) => ({ value, label: value }));
      }),
    count: (filter) =>
      run({ method: 'count', filter }, () => {
        checkFilter(filter);
        return { count: matching(filter).length };
      }),
    members: (req) =>
      run(
        {
          method: 'members',
          filter: req.filter,
          cursor: req.cursor,
          limit: req.limit,
        },
        async () => {
          checkFilter(req.filter);
          checkLimit('limit', req.limit, MAX_PAGE_SIZE);
          if (
            opts.failAfterPages !== undefined &&
            pagesServed >= opts.failAfterPages
          ) {
            throw new SourceUnavailableError('fake_failed_after_pages');
          }
          pagesServed += 1;
          await waitForPage();
          const after = req.cursor;
          const rest = matching(req.filter).filter(
            (member) => after === undefined || member.id > after
          );
          const page = rest.slice(0, req.limit);
          // preview returns displayName as stored; fixtures hold masked names.
          return {
            members: page.map((member) =>
              req.fields === 'preview' && member.displayName !== undefined
                ? { id: member.id, displayName: member.displayName }
                : { id: member.id }
            ),
            nextCursor:
              rest.length > page.length ? (page.at(-1)?.id ?? null) : null,
          };
        }
      ),
    explain: (filter, id) =>
      run({ method: 'explain', filter }, (): Explanation => {
        checkFilter(filter);
        const member = visible.find((m) => m.id === id);
        return {
          id,
          matches: member ? matches(member, filter) : false,
          conditions: leaves(filter).map((leaf) => ({
            dimension: leaf.dimension,
            op: leaf.op,
            matched: member ? matchesCondition(member, leaf) : false,
          })),
        };
      }),
    lookup: (ids, channel) =>
      run({ method: 'lookup' }, (): LookupEntry[] => {
        checkLimit('ids', ids.length, MAX_LOOKUP_IDS);
        return [...new Set(ids)].map((id) =>
          entryFor(
            id,
            sorted.find((m) => m.id === id),
            channel
          )
        );
      }),
    resolve: (rawInputs) =>
      run({ method: 'resolve' }, () => {
        checkLimit('inputs', rawInputs.length, MAX_RESOLVE_INPUTS);
        const { inputs } = normalizeResolveInputs(rawInputs);
        const found: { input: string; id: string }[] = [];
        const unmatched: string[] = [];
        for (const input of inputs) {
          const tooShort =
            !input.includes('@') && digitsOf(input).length < MIN_PHONE_DIGITS;
          const candidates = tooShort
            ? []
            : sorted.filter((member) => contactMatches(member, input));
          // An input shared by several members is ambiguous, so it matches none.
          const [only, ...others] = candidates;
          if (only && others.length === 0) {
            found.push({ input, id: only.id });
          } else {
            unmatched.push(input);
          }
        }
        return { matches: found, unmatched };
      }),
  };

  return { ...source, calls, sourceTimeMs: () => timeMs };
}
