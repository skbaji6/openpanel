import { z } from 'zod';

const MAX_SUBJECT_LENGTH = 300;
const MAX_BODY_LENGTH = 20_000;

export const zStep = z.object({
  delaySeconds: z.number().int().min(0),
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
    cooldownSeconds: z.number().int().min(0),
  }),
  allowedEventProps: z.array(z.string().min(1)),
});

export type Step = z.infer<typeof zStep>;
export type Goal = z.infer<typeof zGoal>;
export type RuleDefinition = z.infer<typeof zRuleDefinition>;
