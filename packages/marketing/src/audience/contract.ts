import { z } from 'zod';

export const MAX_FILTER_DEPTH = 3;
export const MAX_PAGE_SIZE = 1000;
export const MAX_LOOKUP_IDS = 500;
export const MAX_RESOLVE_INPUTS = 200;
export const MAX_ID_CONDITION_VALUES = 1000;
export const RESERVED_ID_DIMENSION = 'id';

export const zOp = z.enum([
  'eq',
  'in',
  'not_in',
  'gt',
  'lt',
  'between',
  'exists',
]);
export type Op = z.infer<typeof zOp>;

const zScalar = z.union([z.string(), z.number(), z.boolean()]);

export const zCondition = z.object({
  dimension: z.string().min(1),
  op: zOp,
  values: z.array(zScalar),
});
export type Condition = z.infer<typeof zCondition>;

export interface FilterGroup {
  op: 'and' | 'or';
  children: FilterTree[];
}
export type FilterTree = Condition | FilterGroup;

export const zFilterTree: z.ZodType<FilterTree> = z.lazy(() =>
  z.union([
    z.object({
      op: z.enum(['and', 'or']),
      children: z.array(zFilterTree).min(1),
    }),
    zCondition,
  ])
);

export const zDimension = z.object({
  key: z.string().min(1),
  label: z.string(),
  type: z.enum(['string', 'number', 'date', 'boolean']),
  multiValued: z.boolean(),
  valuesListable: z.boolean(),
});
export type Dimension = z.infer<typeof zDimension>;

export const zSchema = z.object({ dimensions: z.array(zDimension) });
export type Schema = z.infer<typeof zSchema>;

export const zLookupChannel = z.enum([
  'push',
  'whatsapp',
  'sms',
  'email',
  'none',
]);
export type LookupChannel = z.infer<typeof zLookupChannel>;

export const zMember = z.object({
  id: z.string(),
  displayName: z.string().optional(),
});
export type Member = z.infer<typeof zMember>;

export const zMembersRequest = z.object({
  filter: zFilterTree,
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(MAX_PAGE_SIZE),
  fields: z.enum(['id', 'preview']),
});
export type MembersRequest = z.infer<typeof zMembersRequest>;

export const zMembersResponse = z.object({
  members: z.array(zMember),
  nextCursor: z.string().nullable(),
});
export type MembersResponse = z.infer<typeof zMembersResponse>;

export const zCountResponse = z.object({
  count: z.number().int().min(0),
  approximate: z.boolean().optional(),
});
export type CountResponse = z.infer<typeof zCountResponse>;

export const zLookupRequest = z.object({
  ids: z.array(z.string()).max(MAX_LOOKUP_IDS),
  channel: zLookupChannel,
});
export type LookupRequest = z.infer<typeof zLookupRequest>;

export const zLookupEntry = z.object({
  id: z.string(),
  status: z.enum(['ok', 'not_found', 'suppressed', 'unreachable']),
  reason: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  devices: z
    .array(z.object({ token: z.string(), platform: z.string() }))
    .optional(),
  traits: z.record(z.string(), zScalar).optional(),
  consent: z
    .object({
      whatsapp: z.boolean().optional(),
      sms_promotional: z.boolean().optional(),
    })
    .optional(),
});
export type LookupEntry = z.infer<typeof zLookupEntry>;

export const zLookupResponse = z.object({ entries: z.array(zLookupEntry) });
export type LookupResponse = z.infer<typeof zLookupResponse>;

export const zResolveRequest = z.object({
  inputs: z.array(z.string()).max(MAX_RESOLVE_INPUTS),
});
export type ResolveRequest = z.infer<typeof zResolveRequest>;

export const zResolveResponse = z.object({
  matches: z.array(z.object({ input: z.string(), id: z.string() })),
  unmatched: z.array(z.string()),
});
export type ResolveResponse = z.infer<typeof zResolveResponse>;

export const zExplanation = z.object({
  id: z.string(),
  matches: z.boolean(),
  conditions: z.array(
    z.object({ dimension: z.string(), op: z.string(), matched: z.boolean() })
  ),
});
export type Explanation = z.infer<typeof zExplanation>;

export const zDimensionValueItem = z.object({
  value: z.string(),
  label: z.string(),
});
// The owner's contract does not pin this shape; accept a bare array or {values}.
export const zDimensionValues = z.union([
  z.array(zDimensionValueItem),
  z.object({ values: z.array(zDimensionValueItem) }).transform((v) => v.values),
]);
