import { z } from 'zod';

// Copied verbatim from packages/marketing/src/rules/rule.schema.ts; contract.test.ts fails unless the
// text from MAX_SUBJECT_LENGTH to RuleDefinition matches the service file exactly.
const MAX_SUBJECT_LENGTH = 300;
export const MAX_BODY_LENGTH = 20_000;
export const MAX_DELAY_SECONDS = 90 * 24 * 60 * 60;
export const MAX_STEPS = 20;
export const MAX_VARIANTS = 40;
export const MAX_VARIANT_KEY_LENGTH = 64;
export const MAX_NOTE_LENGTH = 2000;
// The definition is copied into every enrollment: 64 KiB x 50,000 enrollments is at most 3.2 GB for one journey.
export const MAX_DEFINITION_BYTES = 64 * 1024;

export const zInlineTemplate = z.strictObject({
  subject: z.string().max(MAX_SUBJECT_LENGTH).optional(),
  body: z.string().max(MAX_BODY_LENGTH),
});

export const zStepTemplate = z
  .strictObject({
    subject: z.string().max(MAX_SUBJECT_LENGTH).optional(),
    body: z.string().max(MAX_BODY_LENGTH).optional(),
    text: z.string().max(MAX_BODY_LENGTH).optional(),
    templateId: z.uuid().optional(),
    version: z.number().int().min(1).optional(),
  })
  .refine((t) => t.body !== undefined || t.templateId !== undefined, {
    message: 'body or templateId is required',
  });

export const zStep = z
  .object({
    delaySeconds: z.number().int().min(0).max(MAX_DELAY_SECONDS),
    channel: z.enum(['email', 'webhook', 'push']),
    template: zStepTemplate.optional(),
    variants: z
      .record(
        z.string().trim().min(1).max(MAX_VARIANT_KEY_LENGTH),
        zStepTemplate
      )
      .optional(),
    note: z.string().max(MAX_NOTE_LENGTH).optional(),
  })
  .refine(
    (step) =>
      step.template !== undefined ||
      Object.keys(step.variants ?? {}).length > 0,
    { message: 'a step needs a default message or a state variant' }
  )
  .refine((step) => Object.keys(step.variants ?? {}).length <= MAX_VARIANTS, {
    message: 'too many state variants',
  });

export type StepTemplate = z.infer<typeof zStepTemplate>;

export const zGoal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event'), event: z.string().min(1) }),
  z.object({
    kind: z.literal('set'),
    event: z.string().min(1),
    property: z.string().min(1),
    setKey: z.string().min(1),
  }),
  z.object({
    kind: z.literal('inactivity'),
    excludeEvents: z.array(z.string()).default([]),
  }),
]);

export const zRuleDefinition = z.object({
  name: z.string().min(1),
  trigger: z.object({
    event: z.string().min(1),
    filters: z
      .array(z.object({ property: z.string().min(1), equals: z.string() }))
      .optional(),
  }),
  matchOn: z.string().min(1).optional(),
  goal: zGoal,
  steps: z
    .array(zStep)
    .min(1)
    .max(MAX_STEPS)
    .refine(
      (steps) =>
        steps.every(
          (step, i) =>
            i === 0 || step.delaySeconds > (steps[i - 1]?.delaySeconds ?? -1)
        ),
      { message: 'delaySeconds must be strictly increasing' }
    ),
  reentry: z.object({
    enabled: z.boolean(),
    cooldownSeconds: z.number().int().min(0).max(MAX_DELAY_SECONDS),
  }),
  allowedEventProps: z.array(z.string().min(1)),
});

export type Step = z.infer<typeof zStep>;
export type Goal = z.infer<typeof zGoal>;
export type RuleDefinition = z.infer<typeof zRuleDefinition>;

export { MAX_SUBJECT_LENGTH };

export const CHANNELS = zStep.shape.channel.options;
export type Channel = Step['channel'];

export const GOAL_KINDS = zGoal.options.map(
  (option) => option.shape.kind.value
);
export type GoalKind = Goal['kind'];

export type RuleStatus = 'draft' | 'active' | 'paused';

export type JourneyField = 'trigger' | 'goal';

export interface Rule {
  id: string;
  name: string;
  status: RuleStatus;
  version: number;
  definition: RuleDefinition;
  createdAt: string;
  updatedAt: string;
  // Absent on rules created before journeys existed.
  journeyKey?: string | null;
  unconfirmed?: JourneyField[];
}

export interface StarterRule {
  key: string;
  definition: RuleDefinition;
}

// Secret fields come back as this literal; sending it back unchanged keeps the stored value.
export const SECRET_MASK = '********';

export interface ChannelConfigResponse {
  channel: Channel;
  configured: boolean;
  config: Record<string, unknown> | null;
}

export interface RuleResult {
  ruleId: string;
  name: string;
  // Inactivity rules end only by running out of steps, so conversion is not measured for them.
  goalKind: string | null;
  enrolled: number;
  messaged: number;
  sent: number;
  completedAfterSend: number;
  conversionRate: number;
  skipped: number;
  failed: number;
}

export interface ReferenceSetSummary {
  setKey: string;
  count: number;
}

export interface Preview {
  subject?: string;
  body: string;
}

export interface CreatedApiKey {
  id: string;
  label: string;
  key: string;
}

export interface ApiIssue {
  path: string;
  message: string;
}

export type ImportAction =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'skipped_live'
  | 'skipped_edited';

export interface ImportProblem {
  sheet: string;
  row: number | null;
  code: string;
  column?: string;
}

export interface ImportJourney {
  key: string;
  name: string;
  action?: string;
  ruleId: string | null;
  steps: number;
  variants: string[];
  unconfirmed: JourneyField[];
}

export interface ImportReport {
  sheets: string[];
  journeys: ImportJourney[];
  problems: ImportProblem[];
}

export interface ImportRequest {
  format: 'xlsx' | 'csv';
  contentBase64: string;
  dryRun: boolean;
  options: { states: Record<string, string>; overwriteEdited?: boolean };
}

export interface StartResponse {
  rule: Rule | null;
  pinned: {
    stepIndex: number;
    variant: string;
    templateId: string;
    version: number;
  }[];
}

export interface JourneySkipsResponse {
  reasons: { reason: string; count: number }[];
}

export const MAX_IMPORT_BYTES = 512 * 1024;
