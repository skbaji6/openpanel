import { z } from 'zod';

// Copied verbatim from packages/marketing/src/rules/rule.schema.ts; contract.test.ts fails unless the
// text from MAX_SUBJECT_LENGTH to RuleDefinition matches the service file exactly.
const MAX_SUBJECT_LENGTH = 300;
const MAX_BODY_LENGTH = 20_000;
export const MAX_DELAY_SECONDS = 90 * 24 * 60 * 60;
export const MAX_STEPS = 20;

export const zStep = z.object({
  delaySeconds: z.number().int().min(0).max(MAX_DELAY_SECONDS),
  channel: z.enum(['email', 'webhook', 'push']),
  template: z.object({
    subject: z.string().max(MAX_SUBJECT_LENGTH).optional(),
    body: z.string().max(MAX_BODY_LENGTH),
  }),
});

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

export { MAX_BODY_LENGTH, MAX_SUBJECT_LENGTH };

export const CHANNELS = zStep.shape.channel.options;
export type Channel = Step['channel'];

export const GOAL_KINDS = zGoal.options.map(
  (option) => option.shape.kind.value
);
export type GoalKind = Goal['kind'];

export type RuleStatus = 'active' | 'paused';

export interface Rule {
  id: string;
  name: string;
  status: RuleStatus;
  version: number;
  definition: RuleDefinition;
  createdAt: string;
  updatedAt: string;
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
