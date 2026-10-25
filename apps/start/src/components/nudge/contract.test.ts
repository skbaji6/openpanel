import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  MAX_BODY_LENGTH,
  MAX_DELAY_SECONDS,
  MAX_SUBJECT_LENGTH,
  type RuleDefinition,
  zRuleDefinition,
} from './contract';
import starterRules from './starter-rules.fixture.json';

// Read as text, not imported: the dashboard must not depend on the service package's source.
const SERVICE_SCHEMA_SOURCE = readFileSync(
  new URL(
    '../../../../../packages/nudge/src/rules/rule.schema.ts',
    import.meta.url
  ),
  'utf8'
);

function serviceConstant(name: string): number {
  const match = new RegExp(`const ${name} = ([0-9_ *]+);`).exec(
    SERVICE_SCHEMA_SOURCE
  );
  if (!match?.[1]) {
    throw new Error(`${name} not found in the service schema`);
  }
  return match[1]
    .split('*')
    .map((factor) => Number(factor.trim().replaceAll('_', '')))
    .reduce((product, factor) => product * factor, 1);
}

function validRule(): RuleDefinition {
  return structuredClone(starterRules['cart-abandoned']) as RuleDefinition;
}

describe('contract', () => {
  test('contract accepts the same starter rules the service defines', () => {
    for (const definition of Object.values(starterRules)) {
      expect(zRuleDefinition.safeParse(definition).success).toBe(true);
    }
  });

  test('contract rejects a rule with non-increasing delays', () => {
    const rule = validRule();
    const [first, second] = rule.steps;
    if (!(first && second)) {
      throw new Error('fixture needs two steps');
    }
    second.delaySeconds = first.delaySeconds;
    expect(zRuleDefinition.safeParse(rule).success).toBe(false);
  });

  test('contract rejects a rule without steps or with an unknown channel', () => {
    expect(
      zRuleDefinition.safeParse({ ...validRule(), steps: [] }).success
    ).toBe(false);
    const rule = validRule();
    const unknownChannel = {
      ...rule,
      steps: [{ ...rule.steps[0], channel: 'sms' }],
    };
    expect(zRuleDefinition.safeParse(unknownChannel).success).toBe(false);
  });

  test('contract rejects a set goal without a set key', () => {
    const rule = {
      ...validRule(),
      goal: { kind: 'set', event: 'section_opened', property: 'section_id' },
    };
    expect(zRuleDefinition.safeParse(rule).success).toBe(false);
  });

  test('contract limits match the service schema', () => {
    expect(MAX_DELAY_SECONDS).toBe(serviceConstant('MAX_DELAY_SECONDS'));
    expect(MAX_SUBJECT_LENGTH).toBe(serviceConstant('MAX_SUBJECT_LENGTH'));
    expect(MAX_BODY_LENGTH).toBe(serviceConstant('MAX_BODY_LENGTH'));
  });

  test('contract enforces the limits at their boundaries', () => {
    const atLimit = validRule();
    const step = atLimit.steps[1];
    if (!step) {
      throw new Error('fixture needs two steps');
    }
    step.delaySeconds = MAX_DELAY_SECONDS;
    step.template = {
      subject: 'x'.repeat(MAX_SUBJECT_LENGTH),
      body: 'x'.repeat(MAX_BODY_LENGTH),
    };
    expect(zRuleDefinition.safeParse(atLimit).success).toBe(true);

    const overLimit = [
      { delaySeconds: MAX_DELAY_SECONDS + 1 },
      { template: { subject: 'x'.repeat(MAX_SUBJECT_LENGTH + 1), body: '' } },
      { template: { body: 'x'.repeat(MAX_BODY_LENGTH + 1) } },
    ];
    for (const change of overLimit) {
      const rule = validRule();
      rule.steps[1] = { ...step, ...change };
      expect(zRuleDefinition.safeParse(rule).success).toBe(false);
    }
  });

  test('contract strips unknown keys like the service schema', () => {
    expect(SERVICE_SCHEMA_SOURCE).not.toContain('strictObject');
    const parsed = zRuleDefinition.parse({ ...validRule(), extra: true });
    expect(parsed).not.toHaveProperty('extra');
  });
});
