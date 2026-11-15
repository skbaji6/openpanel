import { describe, expect, test } from 'vitest';
import { MarketingApiError } from './api';
import type { TemplateRow } from './campaign-contract';
import type { Rule, RuleDefinition } from './contract';
import { describeStart, startErrorMessage } from './journey-start';

const DAY = 86_400;

function ruleWith(
  steps: RuleDefinition['steps'],
  unconfirmed: ('trigger' | 'goal')[] = []
): Rule {
  return {
    id: 'r1',
    name: 'J',
    status: 'draft',
    version: 2,
    createdAt: '',
    updatedAt: '',
    journeyKey: 'j',
    unconfirmed,
    definition: {
      name: 'J',
      trigger: {
        event: 'signup',
        filters: [{ property: 'plan', equals: 'pro' }],
      },
      goal: { kind: 'event', event: 'paid' },
      steps,
      reentry: { enabled: false, cooldownSeconds: 0 },
      allowedEventProps: [],
    },
  };
}

const NO_TEMPLATES: TemplateRow[] = [];

describe('describeStart', () => {
  test('a step with TS and AP and no default warns no_default_variant', () => {
    const view = describeStart(
      ruleWith([
        {
          delaySeconds: DAY,
          channel: 'push',
          variants: { TS: { body: 'a' }, AP: { body: 'b' } },
        },
      ]),
      NO_TEMPLATES
    );
    expect(view.warnings).toContain('no_default_variant');
    expect(view.steps[0]).toMatchObject({
      delay: 'after 1 day',
      variants: ['TS', 'AP'],
      hasDefault: false,
    });
    expect(view.reactsTo).toBe('signup');
    expect(view.filters).toEqual(['plan = pro']);
    expect(view.goal).toBe('paid');
  });

  test('variants add state_trait_required', () => {
    const withVariants = describeStart(
      ruleWith([
        {
          delaySeconds: 0,
          channel: 'push',
          template: { body: 'x' },
          variants: { TS: { body: 'a' } },
        },
      ]),
      NO_TEMPLATES
    );
    expect(withVariants.warnings).toContain('state_trait_required');
    expect(withVariants.warnings).not.toContain('no_default_variant');
    const plain = describeStart(
      ruleWith([{ delaySeconds: 0, channel: 'push', template: { body: 'x' } }]),
      NO_TEMPLATES
    );
    expect(plain.warnings).toEqual([]);
  });

  test('unconfirmed fields become warnings', () => {
    const view = describeStart(
      ruleWith(
        [{ delaySeconds: 0, channel: 'push', template: { body: 'x' } }],
        ['trigger', 'goal']
      ),
      NO_TEMPLATES
    );
    expect(view.warnings).toEqual(['unconfirmed_trigger', 'unconfirmed_goal']);
  });

  test('a rule without the journey fields still describes', () => {
    const rule = ruleWith([
      { delaySeconds: 0, channel: 'push', template: { body: 'x' } },
    ]);
    rule.unconfirmed = undefined;
    expect(describeStart(rule, NO_TEMPLATES).warnings).toEqual([]);
  });

  test('a pinned ref is described as name and version', () => {
    const templates = [
      { templateId: 't1', displayName: 'Welcome', currentVersion: 5 },
    ] as TemplateRow[];
    const view = describeStart(
      ruleWith([
        {
          delaySeconds: 0,
          channel: 'email',
          template: { templateId: 't1', version: 3 },
        },
      ]),
      templates
    );
    expect(view.steps[0]?.template).toBe('Welcome v3');
  });
});

describe('startErrorMessage', () => {
  test('journey_unconfirmed names the fields', () => {
    const error = new MarketingApiError(409, 'journey_unconfirmed', [], {
      fields: ['trigger', 'goal'],
    });
    expect(startErrorMessage(error)).toContain('trigger event');
    expect(startErrorMessage(error)).toContain('goal event');
  });

  test('a pin failure names the step and variant', () => {
    const error = new MarketingApiError(409, 'template_disabled', [], {
      stepIndex: 1,
      variant: 'TS',
    });
    expect(startErrorMessage(error)).toMatch(/Step 2.*TS/);
  });
});
