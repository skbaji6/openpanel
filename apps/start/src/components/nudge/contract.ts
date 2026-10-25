import { z } from 'zod';

// A copy of the nudge service's rule schema; contract.test.ts fails when the two drift apart.
export const MAX_SUBJECT_LENGTH = 300;
export const MAX_BODY_LENGTH = 20_000;
export const MAX_DELAY_SECONDS = 90 * 24 * 60 * 60;

export const CHANNELS = ['email', 'webhook', 'push'] as const;
export type Channel = (typeof CHANNELS)[number];

export const GOAL_KINDS = ['event', 'set', 'inactivity'] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];

export const zStep = z.object({
  delaySeconds: z.number().int().min(0).max(MAX_DELAY_SECONDS),
  channel: z.enum(CHANNELS),
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
  enrolled: number;
  nudged: number;
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
