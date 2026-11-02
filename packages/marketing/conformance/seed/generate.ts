// Builds the seed contract deterministically: dataset.json, seed.sql and
// expected.json. Expected results come from a small in-memory evaluator, an
// oracle independent of any SQL implementation.
// Regenerate with `bun conformance/seed/generate.ts`; generate.test.ts fails
// when the committed files drift from this script.
import { writeFileSync } from 'node:fs';
import type {
  Condition,
  FilterTree,
  LookupChannel,
} from '../../src/audience/contract';

export const SCHEMA_NAME = 'conformance_demo';
const STUDENT_COUNT = 120;
const FIRST_STUDENT_ID = 1001;
const MISSING_ID = '9999';
const FIRST_SIGNUP_MS = Date.UTC(2025, 0, 1);
const SIGNUP_STEP_DAYS = 3;
const MS_PER_DAY = 86_400_000;
const PAGE_SIZE = 7;
// Expiry dates are only ever FAR_PAST or FAR_FUTURE, so any real "today" between them gives the same purchase status.
const FAR_PAST = '2000-01-01';
const FAR_FUTURE = '2999-12-31';

const FIRST_NAMES = [
  'Asha',
  'Bala',
  'Chitra',
  'Dev',
  'Esha',
  'Farid',
  'Gita',
  'Hari',
  'Indu',
  'Jai',
  'Kavya',
  'Lakshmi',
];
const LAST_NAMES = [
  'Rao',
  'Iyer',
  'Nair',
  'Menon',
  'Pillai',
  'Khan',
  'Sen',
  'Das',
  'Gupta',
  'Reddy',
];

export interface Student {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  emailVerified: boolean;
  phone: string | null;
  universityId: number;
  courseId: number | null;
  semesterId: number | null;
  signupDate: string;
  suppressed: boolean;
  whatsappConsent: boolean;
  smsConsent: boolean;
}

export interface Dataset {
  universities: { id: number; name: string }[];
  courses: { id: number; name: string }[];
  semesters: { id: number; name: string }[];
  students: Student[];
  enrollments: { studentId: string; courseId: number }[];
  devices: {
    studentId: string;
    token: string | null;
    platform: string;
    active: boolean;
  }[];
  purchases: {
    studentId: string;
    isActive: boolean;
    expiryDate: string | null;
  }[];
}

const COURSE_IDS = [11, 12, 13, 14];

export function buildDataset(): Dataset {
  const students: Student[] = [];
  const enrollments: Dataset['enrollments'] = [];
  const devices: Dataset['devices'] = [];
  const purchases: Dataset['purchases'] = [];
  for (let i = 0; i < STUDENT_COUNT; i++) {
    const id = String(FIRST_STUDENT_ID + i);
    const courseId = i % 23 === 5 ? null : (COURSE_IDS[i % 4] ?? null);
    students.push({
      id,
      firstName: FIRST_NAMES[i % FIRST_NAMES.length] ?? '',
      lastName: LAST_NAMES[i % LAST_NAMES.length] ?? '',
      email: i % 13 === 4 ? null : `student${id}@example.test`,
      emailVerified: i % 11 !== 2,
      phone: i % 9 === 1 ? null : `9190000${id.padStart(5, '0')}`,
      universityId: 1 + (i % 3),
      courseId,
      semesterId: i % 29 === 7 ? null : 1 + (Math.floor(i / 3) % 2),
      signupDate: new Date(FIRST_SIGNUP_MS + i * SIGNUP_STEP_DAYS * MS_PER_DAY)
        .toISOString()
        .slice(0, 10),
      suppressed: i % 17 === 3,
      whatsappConsent: i % 2 === 0,
      smsConsent: i % 3 !== 0,
    });
    if (i % 15 === 0 && courseId !== null) {
      // Second course; one student is also enrolled in their primary course again.
      enrollments.push({
        studentId: id,
        courseId: COURSE_IDS[(COURSE_IDS.indexOf(courseId) + 1) % 4] ?? 11,
      });
    }
    if (i === 30 && courseId !== null) {
      enrollments.push({ studentId: id, courseId });
    }
    if (i % 5 !== 0) {
      devices.push({
        studentId: id,
        token: `tok-${id}`,
        platform: i % 2 ? 'android' : 'ios',
        active: true,
      });
    }
    if (i % 10 === 0) {
      devices.push({
        studentId: id,
        token: `tok-${id}-old`,
        platform: 'android',
        active: false,
      });
    }
    if (i % 25 === 5) {
      devices.push({ studentId: id, token: '', platform: 'ios', active: true });
    }
    if (i % 6 === 0) {
      purchases.push({ studentId: id, isActive: true, expiryDate: null });
    } else if (i % 6 === 1) {
      purchases.push({ studentId: id, isActive: true, expiryDate: FAR_PAST });
    } else if (i % 6 === 2) {
      purchases.push({ studentId: id, isActive: false, expiryDate: null });
    } else if (i % 8 === 3) {
      purchases.push({ studentId: id, isActive: true, expiryDate: FAR_FUTURE });
    }
  }
  return {
    universities: [
      { id: 1, name: 'Alpha University' },
      { id: 2, name: 'Beta University' },
      { id: 3, name: 'Gamma University' },
    ],
    courses: [
      { id: 11, name: 'Medicine' },
      { id: 12, name: 'Nursing' },
      { id: 13, name: 'Pharmacy' },
      { id: 14, name: 'Dentistry' },
    ],
    semesters: [
      { id: 1, name: 'Semester 1' },
      { id: 2, name: 'Semester 2' },
    ],
    students,
    enrollments,
    devices,
    purchases,
  };
}

const sqlValue = (value: string | number | boolean | null) => {
  if (value === null) {
    return 'NULL';
  }
  if (typeof value === 'string') {
    return `'${value.replaceAll("'", "''")}'`;
  }
  return String(value);
};

function insert(
  table: string,
  columns: string[],
  rows: (string | number | boolean | null)[][]
) {
  const values = rows.map((row) => `  (${row.map(sqlValue).join(', ')})`);
  return `INSERT INTO ${SCHEMA_NAME}.${table} (${columns.join(', ')}) VALUES\n${values.join(',\n')};\n`;
}

export function renderSeedSql(data: Dataset): string {
  const s = SCHEMA_NAME;
  return `-- Generated by generate.ts from dataset.json; do not edit by hand.
-- The conformance seed contract. Recreates schema ${s} only.
DROP SCHEMA IF EXISTS ${s} CASCADE;
CREATE SCHEMA ${s};

CREATE TABLE ${s}.universities (id bigint PRIMARY KEY, name text NOT NULL);
CREATE TABLE ${s}.courses (id bigint PRIMARY KEY, name text NOT NULL);
CREATE TABLE ${s}.semesters (id bigint PRIMARY KEY, name text NOT NULL);

CREATE TABLE ${s}.students (
  id bigint PRIMARY KEY,
  first_name text NOT NULL,
  last_name text NOT NULL,
  display_name text NOT NULL,
  email text,
  email_verified boolean NOT NULL,
  phone text,
  university_id bigint NOT NULL REFERENCES ${s}.universities (id),
  course_id bigint REFERENCES ${s}.courses (id),
  semester_id bigint REFERENCES ${s}.semesters (id),
  signup_date date NOT NULL,
  suppressed boolean NOT NULL,
  whatsapp_consent boolean NOT NULL,
  sms_consent boolean NOT NULL
);

CREATE TABLE ${s}.enrollments (
  student_id bigint NOT NULL REFERENCES ${s}.students (id),
  course_id bigint NOT NULL REFERENCES ${s}.courses (id)
);

CREATE TABLE ${s}.devices (
  student_id bigint NOT NULL REFERENCES ${s}.students (id),
  token text,
  platform text NOT NULL,
  active boolean NOT NULL
);

CREATE TABLE ${s}.purchases (
  student_id bigint NOT NULL REFERENCES ${s}.students (id),
  is_active boolean NOT NULL,
  expiry_date date
);

-- The course dimension: the primary course or any enrollment.
CREATE VIEW ${s}.student_courses AS
  SELECT id AS student_id, course_id FROM ${s}.students WHERE course_id IS NOT NULL
  UNION
  SELECT student_id, course_id FROM ${s}.enrollments;

${insert(
  'universities',
  ['id', 'name'],
  data.universities.map((u) => [u.id, u.name])
)}
${insert(
  'courses',
  ['id', 'name'],
  data.courses.map((c) => [c.id, c.name])
)}
${insert(
  'semesters',
  ['id', 'name'],
  data.semesters.map((m) => [m.id, m.name])
)}
${insert(
  'students',
  [
    'id',
    'first_name',
    'last_name',
    'display_name',
    'email',
    'email_verified',
    'phone',
    'university_id',
    'course_id',
    'semester_id',
    'signup_date',
    'suppressed',
    'whatsapp_consent',
    'sms_consent',
  ],
  data.students.map((st) => [
    Number(st.id),
    st.firstName,
    st.lastName,
    `${st.firstName} ${st.lastName}`,
    st.email,
    st.emailVerified,
    st.phone,
    st.universityId,
    st.courseId,
    st.semesterId,
    st.signupDate,
    st.suppressed,
    st.whatsappConsent,
    st.smsConsent,
  ])
)}
${insert(
  'enrollments',
  ['student_id', 'course_id'],
  data.enrollments.map((e) => [Number(e.studentId), e.courseId])
)}
${insert(
  'devices',
  ['student_id', 'token', 'platform', 'active'],
  data.devices.map((d) => [Number(d.studentId), d.token, d.platform, d.active])
)}
${insert(
  'purchases',
  ['student_id', 'is_active', 'expiry_date'],
  data.purchases.map((p) => [Number(p.studentId), p.isActive, p.expiryDate])
)}`;
}

type Value = string | number | boolean;

function dimensionValues(data: Dataset, st: Student, key: string): Value[] {
  switch (key) {
    case 'university':
      return [st.universityId];
    case 'semester':
      return st.semesterId === null ? [] : [st.semesterId];
    case 'signup_date':
      return [st.signupDate];
    case 'course': {
      const extra = data.enrollments
        .filter((e) => e.studentId === st.id)
        .map((e) => e.courseId);
      return [
        ...new Set([...(st.courseId === null ? [] : [st.courseId]), ...extra]),
      ];
    }
    case 'purchase_status': {
      const purchased = data.purchases.some(
        (p) =>
          p.studentId === st.id &&
          p.isActive &&
          (p.expiryDate === null || p.expiryDate === FAR_FUTURE)
      );
      return [purchased ? 'PURCHASED' : 'NOT_PURCHASED'];
    }
    case 'id':
      return [st.id];
    default:
      throw new Error(`oracle: unknown dimension ${key}`);
  }
}

// Contract semantics: not_in includes students with no value; multi-valued conditions match any value.
function matchesCondition(data: Dataset, st: Student, c: Condition): boolean {
  const own = dimensionValues(data, st, c.dimension);
  const [first, second] = c.values;
  switch (c.op) {
    case 'eq':
    case 'in':
      return own.some((v) => c.values.includes(v));
    case 'not_in':
      return !own.some((v) => c.values.includes(v));
    case 'gt':
      return own.some((v) => first !== undefined && v > first);
    case 'lt':
      return own.some((v) => first !== undefined && v < first);
    case 'between':
      return own.some(
        (v) =>
          first !== undefined &&
          second !== undefined &&
          v >= first &&
          v <= second
      );
    case 'exists':
      return own.length > 0;
    default:
      throw new Error('oracle: unknown op');
  }
}

function matches(data: Dataset, st: Student, filter: FilterTree): boolean {
  if ('children' in filter) {
    const results = filter.children.map((child) => matches(data, st, child));
    return filter.op === 'and' ? results.every(Boolean) : results.some(Boolean);
  }
  return matchesCondition(data, st, filter);
}

const leaves = (filter: FilterTree): Condition[] =>
  'children' in filter ? filter.children.flatMap(leaves) : [filter];

// Suppressed students are never audience members.
function memberIds(data: Dataset, filter: FilterTree): string[] {
  return data.students
    .filter((st) => !st.suppressed && matches(data, st, filter))
    .map((st) => st.id)
    .sort();
}

const NAMED_FILTERS: Record<string, FilterTree> = {
  all: { dimension: 'id', op: 'not_in', values: [MISSING_ID] },
  university_eq: { dimension: 'university', op: 'eq', values: [2] },
  course_in_multi: { dimension: 'course', op: 'in', values: [11, 12] },
  course_not_in_with_nulls: { dimension: 'course', op: 'not_in', values: [11] },
  course_exists: { dimension: 'course', op: 'exists', values: [] },
  semester_not_in_with_nulls: {
    dimension: 'semester',
    op: 'not_in',
    values: [1],
  },
  semester_gt: { dimension: 'semester', op: 'gt', values: [1] },
  signup_between: {
    dimension: 'signup_date',
    op: 'between',
    values: ['2025-03-01', '2025-06-30'],
  },
  signup_lt: { dimension: 'signup_date', op: 'lt', values: ['2025-02-15'] },
  purchased: { dimension: 'purchase_status', op: 'eq', values: ['PURCHASED'] },
  not_purchased: {
    dimension: 'purchase_status',
    op: 'eq',
    values: ['NOT_PURCHASED'],
  },
  id_in: {
    dimension: 'id',
    op: 'in',
    values: ['1001', '1004', '1050', '1120', MISSING_ID],
  },
  and_or_nested: {
    op: 'and',
    children: [
      { dimension: 'university', op: 'in', values: [1, 3] },
      {
        op: 'or',
        children: [
          { dimension: 'course', op: 'eq', values: [13] },
          { dimension: 'purchase_status', op: 'eq', values: ['PURCHASED'] },
        ],
      },
    ],
  },
  or_and_nested: {
    op: 'or',
    children: [
      {
        op: 'and',
        children: [
          { dimension: 'semester', op: 'eq', values: [2] },
          { dimension: 'course', op: 'not_in', values: [12, 14] },
        ],
      },
      { dimension: 'id', op: 'in', values: ['1002', '1003'] },
    ],
  },
};

const PAGED_FILTERS = ['all', 'course_in_multi', 'and_or_nested'];
const EXPLAINED: [string, string][] = [
  ['and_or_nested', '1001'],
  ['and_or_nested', '1002'],
  ['and_or_nested', '1003'],
  ['or_and_nested', '1002'],
  ['course_in_multi', '1016'],
];

function unreachableReason(
  data: Dataset,
  st: Student,
  channel: LookupChannel
): string | undefined {
  if (channel === 'email') {
    if (st.email === null) {
      return 'no_email';
    }
    return st.emailVerified ? undefined : 'unverified_email';
  }
  if (channel === 'sms' || channel === 'whatsapp') {
    return st.phone === null ? 'no_valid_phone' : undefined;
  }
  if (channel === 'push') {
    const usable = data.devices.some(
      (d) => d.studentId === st.id && d.active && d.token
    );
    return usable ? undefined : 'no_active_device';
  }
  return undefined;
}

function lookupEntry(data: Dataset, id: string, channel: LookupChannel) {
  const st = data.students.find((s) => s.id === id);
  if (!st) {
    return { id, status: 'not_found' };
  }
  if (st.suppressed) {
    return { id, status: 'suppressed' };
  }
  const reason = unreachableReason(data, st, channel);
  return reason ? { id, status: 'unreachable', reason } : { id, status: 'ok' };
}

// One id per interesting case, chosen from the data so the cases cannot drift.
function lookupIds(data: Dataset, channel: LookupChannel): string[] {
  const live = data.students.filter((s) => !s.suppressed);
  const pick = (test: (s: Student) => boolean) =>
    live.find(test)?.id ?? MISSING_ID;
  const suppressed = data.students.find((s) => s.suppressed)?.id ?? MISSING_ID;
  const reachable = live.filter((s) => !unreachableReason(data, s, channel));
  const unreachable = live.filter((s) => unreachableReason(data, s, channel));
  const ids = [
    ...reachable.slice(0, 2).map((s) => s.id),
    ...unreachable.slice(0, 2).map((s) => s.id),
    suppressed,
    MISSING_ID,
  ];
  if (channel === 'email') {
    ids.push(pick((s) => s.email === null));
  }
  if (channel === 'push') {
    // Only an inactive or a blank-token device.
    ids.push(
      pick(
        (s) =>
          data.devices.some((d) => d.studentId === s.id) &&
          !data.devices.some((d) => d.studentId === s.id && d.active && d.token)
      )
    );
  }
  return [...new Set(ids)];
}

const CHANNELS: LookupChannel[] = ['email', 'sms', 'whatsapp', 'push', 'none'];

export function buildExpected(data: Dataset) {
  const counts = Object.entries(NAMED_FILTERS).map(([name, filter]) => ({
    name,
    filter,
    count: memberIds(data, filter).length,
  }));
  const pages = PAGED_FILTERS.map((name) => {
    const filter = NAMED_FILTERS[name] as FilterTree;
    const ids = memberIds(data, filter);
    if (ids.length % PAGE_SIZE === 0) {
      throw new Error('a paged filter must not fill its last page exactly');
    }
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += PAGE_SIZE) {
      chunks.push(ids.slice(i, i + PAGE_SIZE));
    }
    return { name, filter, limit: PAGE_SIZE, pages: chunks };
  });
  const explanations = EXPLAINED.map(([name, id]) => {
    const filter = NAMED_FILTERS[name] as FilterTree;
    const st = data.students.find((s) => s.id === id);
    if (!st || st.suppressed) {
      throw new Error('explain cases must be live students');
    }
    return {
      name,
      filter,
      id,
      matches: matches(data, st, filter),
      conditions: leaves(filter).map((leaf) => ({
        dimension: leaf.dimension,
        op: leaf.op,
        matched: matchesCondition(data, st, leaf),
      })),
    };
  });
  const lookups = CHANNELS.map((channel) => {
    const ids = lookupIds(data, channel);
    return {
      channel,
      ids,
      entries: ids.map((id) => lookupEntry(data, id, channel)),
    };
  });
  const multi = data.enrollments.find((e) => {
    const st = data.students.find((s) => s.id === e.studentId);
    return st && !st.suppressed && st.courseId !== e.courseId;
  });
  const multiStudent = data.students.find((s) => s.id === multi?.studentId);
  if (!(multi && multiStudent?.courseId)) {
    throw new Error('the dataset needs a live multi-course student');
  }
  const multiFilter: FilterTree = {
    dimension: 'course',
    op: 'in',
    values: [multiStudent.courseId, multi.courseId],
  };
  const live = data.students.filter((s) => !s.suppressed);
  const [first, second] = live.filter((s) => s.email && s.phone);
  if (!(first?.email && second?.phone)) {
    throw new Error('the dataset needs students with email and phone');
  }
  return {
    order:
      'Member ids ascend compared as text. Dataset ids all have four digits, so numeric order is the same.',
    suppression:
      'Suppressed students are never audience members (count, members, explain); lookup reports them as suppressed.',
    counts,
    pages,
    explanations,
    multiCourse: {
      id: multiStudent.id,
      filter: multiFilter,
      count: memberIds(data, multiFilter).length,
    },
    lookups,
    resolve: {
      inputs: [
        first.email.toUpperCase(),
        `+${second.phone.slice(0, 2)} ${second.phone.slice(2)}`,
        'nobody@example.test',
      ],
      matches: [
        { input: first.email.toUpperCase(), id: first.id },
        {
          input: `+${second.phone.slice(0, 2)} ${second.phone.slice(2)}`,
          id: second.id,
        },
      ],
      unmatched: ['nobody@example.test'],
    },
    values: [
      {
        dimension: 'university',
        q: 'BETA',
        limit: 5,
        values: [{ value: '2', label: 'Beta University' }],
      },
      {
        dimension: 'course',
        q: '',
        limit: 10,
        values: data.courses
          .map((c) => ({ value: String(c.id), label: c.name }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      },
    ],
  };
}

export type Expected = ReturnType<typeof buildExpected>;

if (import.meta.main) {
  const data = buildDataset();
  const dir = new URL('./', import.meta.url);
  writeFileSync(
    new URL('dataset.json', dir),
    `${JSON.stringify(data, null, 2)}\n`
  );
  writeFileSync(new URL('seed.sql', dir), renderSeedSql(data));
  writeFileSync(
    new URL('expected.json', dir),
    `${JSON.stringify(buildExpected(data), null, 2)}\n`
  );
}
