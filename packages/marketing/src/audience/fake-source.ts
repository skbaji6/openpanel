import {
  type Condition,
  type Explanation,
  type FilterTree,
  type LookupEntry,
  RESERVED_ID_DIMENSION,
  type Schema,
} from './contract';
import { SourceUnavailableError } from './errors';
import type { AudienceSource } from './source';

type Scalar = string | number | boolean;

export interface FakeMember {
  id: string;
  values: Record<string, Scalar | (string | number)[]>;
  displayName?: string;
  contact?: { phone?: string; email?: string };
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
  sleep?: (ms: number) => Promise<void>;
}

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

function matchesCondition(member: FakeMember, condition: Condition): boolean {
  const present = valuesOf(member, condition.dimension);
  const { op, values } = condition;
  const anyPresent = (test: (value: Scalar) => boolean) => present.some(test);
  switch (op) {
    case 'eq':
      return anyPresent((value) => value === values[0]);
    case 'in':
      return anyPresent((value) => values.includes(value));
    case 'not_in':
      // A member with no value for the dimension is not in the list.
      return !anyPresent((value) => values.includes(value));
    case 'gt':
      return anyPresent((value) => value > (values[0] as Scalar));
    case 'lt':
      return anyPresent((value) => value < (values[0] as Scalar));
    case 'between':
      return anyPresent(
        (value) =>
          value >= (values[0] as Scalar) && value <= (values[1] as Scalar)
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

function leaves(filter: FilterTree): Condition[] {
  return 'children' in filter ? filter.children.flatMap(leaves) : [filter];
}

export function createFakeSource(opts: FakeSourceOptions) {
  // Byte order, as the reference service sorts ids with COLLATE "C".
  const sorted = [...opts.members].sort((a, b) =>
    a.id < b.id ? -1 : Number(a.id > b.id)
  );
  const calls: FakeCall[] = [];
  let timeMs = 0;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function run<T>(
    call: FakeCall,
    body: () => T | Promise<T>
  ): Promise<T> {
    calls.push(call);
    if (opts.down?.()) {
      throw new SourceUnavailableError('fake_down');
    }
    const started = performance.now();
    try {
      return await body();
    } finally {
      timeMs += performance.now() - started;
    }
  }

  const matching = (filter: FilterTree) =>
    sorted.filter((member) => matches(member, filter));

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
        return [...distinct]
          .filter((value) => value.includes(q))
          .slice(0, limit)
          .map((value) => ({ value, label: value }));
      }),
    count: (filter) =>
      run({ method: 'count', filter }, () => ({
        count: matching(filter).length,
      })),
    members: (req) =>
      run(
        {
          method: 'members',
          filter: req.filter,
          cursor: req.cursor,
          limit: req.limit,
        },
        async () => {
          if (opts.pageDelayMs) {
            await sleep(opts.pageDelayMs);
            timeMs += opts.pageDelayMs;
          }
          const after = req.cursor;
          const rest = matching(req.filter).filter(
            (member) => after === undefined || member.id > after
          );
          const page = rest.slice(0, req.limit);
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
        const member = sorted.find((m) => m.id === id);
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
    lookup: (ids) =>
      run({ method: 'lookup' }, (): LookupEntry[] =>
        ids.map((id) => {
          const member = sorted.find((m) => m.id === id);
          return member
            ? {
                id,
                status: 'ok',
                email: member.contact?.email,
                phone: member.contact?.phone,
              }
            : { id, status: 'not_found' };
        })
      ),
    resolve: (inputs) =>
      run({ method: 'resolve' }, () => {
        const found: { input: string; id: string }[] = [];
        const unmatched: string[] = [];
        for (const input of inputs) {
          const member = sorted.find(
            (m) => m.contact?.phone === input || m.contact?.email === input
          );
          if (member) {
            found.push({ input, id: member.id });
          } else {
            unmatched.push(input);
          }
        }
        return { matches: found, unmatched };
      }),
  };

  return { ...source, calls, sourceTimeMs: () => timeMs };
}
