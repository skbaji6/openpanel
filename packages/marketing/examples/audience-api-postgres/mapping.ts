import { z } from 'zod';
import { RESERVED_ID_DIMENSION } from '../../src/audience/contract';

// Mapping names are developer-supplied configuration, not user input, but they are
// still checked once at startup so a typo cannot become SQL.
export const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;

const zIdentifier = z.string().regex(IDENTIFIER, 'not a valid identifier');

const zExists = z.object({
  table: zIdentifier,
  studentColumn: zIdentifier,
  valueColumn: zIdentifier,
});

const zDimensionMapping = z
  .object({
    key: z.string().min(1),
    label: z.string(),
    type: z.enum(['string', 'number', 'date', 'boolean']),
    multiValued: z.boolean().default(false),
    // One of: a column on the students table, a trusted SQL expression over the
    // alias `s` (for computed dimensions such as purchase_status), or an EXISTS
    // sub-select over a child relation (multi-valued dimensions).
    column: zIdentifier.optional(),
    expression: z
      .string()
      .refine((value) => !value.includes(';'), 'no statement separators')
      .optional(),
    exists: zExists.optional(),
    values: z
      .object({
        table: zIdentifier,
        valueColumn: zIdentifier,
        labelColumn: zIdentifier.optional(),
      })
      .optional(),
    staticValues: z
      .array(z.object({ value: z.string(), label: z.string() }))
      .optional(),
  })
  .refine(
    (d) =>
      [d.column, d.expression, d.exists].filter((v) => v !== undefined)
        .length === 1,
    'exactly one of column, expression, exists'
  )
  .refine((d) => d.key !== RESERVED_ID_DIMENSION, 'id is reserved')
  .refine((d) => !d.multiValued || d.exists, 'multiValued needs exists');

export const zMapping = z
  .object({
    studentsTable: zIdentifier,
    idColumn: zIdentifier,
    displayNameColumn: zIdentifier.optional(),
    dimensions: z.array(zDimensionMapping),
    contact: z
      .object({
        emailColumn: zIdentifier.optional(),
        emailVerifiedColumn: zIdentifier.optional(),
        phoneColumn: zIdentifier.optional(),
        suppressedColumn: zIdentifier.optional(),
        consent: z
          .object({
            whatsapp: zIdentifier.optional(),
            smsPromotional: zIdentifier.optional(),
          })
          .optional(),
        traits: z.record(z.string(), zIdentifier).default({}),
      })
      .default({ traits: {} }),
    devices: z
      .object({
        table: zIdentifier,
        studentColumn: zIdentifier,
        tokenColumn: zIdentifier,
        platformColumn: zIdentifier,
        activeColumn: zIdentifier.optional(),
      })
      .optional(),
  })
  .refine(
    (m) => new Set(m.dimensions.map((d) => d.key)).size === m.dimensions.length,
    'duplicate dimension key'
  );

export type Mapping = z.infer<typeof zMapping>;
export type DimensionMapping = Mapping['dimensions'][number];

export function parseMapping(raw: unknown): Mapping {
  const parsed = zMapping.safeParse(raw);
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`invalid audience mapping at: ${where}`);
  }
  return parsed.data;
}
