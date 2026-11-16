import { describe, expect, it } from 'bun:test';
import { MAX_DELAY_SECONDS, MAX_STEPS, zRuleDefinition } from './rule.schema';
import { STARTER_RULES } from './starter-rules';

const valid = STARTER_RULES['cart-abandoned'];

describe('zRuleDefinition', () => {
  it('accepts each STARTER_RULES entry', () => {
    expect(Object.keys(STARTER_RULES).sort()).toEqual([
      'bought-never-opened',
      'cart-abandoned',
      'opened-sections-untouched',
      'registered-not-bought',
    ]);
    for (const rule of Object.values(STARTER_RULES)) {
      expect(zRuleDefinition.safeParse(rule).success).toBe(true);
    }
  });

  it('rejects steps whose delays are not strictly increasing', () => {
    const step = valid.steps[0]!;
    for (const delays of [
      [60, 60],
      [120, 60],
    ]) {
      const steps = delays.map((delaySeconds) => ({ ...step, delaySeconds }));
      expect(zRuleDefinition.safeParse({ ...valid, steps }).success).toBe(
        false
      );
    }
  });

  it('accepts MAX_STEPS steps and rejects one more', () => {
    const step = valid.steps[0]!;
    const steps = (count: number) =>
      Array.from({ length: count }, (_unused, index) => ({
        ...step,
        delaySeconds: (index + 1) * 60,
      }));
    expect(
      zRuleDefinition.safeParse({ ...valid, steps: steps(MAX_STEPS) }).success
    ).toBe(true);
    expect(
      zRuleDefinition.safeParse({ ...valid, steps: steps(MAX_STEPS + 1) })
        .success
    ).toBe(false);
  });

  it('rejects a set goal without setKey', () => {
    const goal = {
      kind: 'set',
      event: 'section_opened',
      property: 'section_id',
    };
    expect(zRuleDefinition.safeParse({ ...valid, goal }).success).toBe(false);
  });

  it('rejects zero steps', () => {
    expect(zRuleDefinition.safeParse({ ...valid, steps: [] }).success).toBe(
      false
    );
  });

  it('rejects oversized subject and body', () => {
    const step = valid.steps[0]!;
    const withTemplate = (template: { subject?: string; body: string }) =>
      zRuleDefinition.safeParse({
        ...valid,
        steps: [{ ...step, template }],
      }).success;
    expect(withTemplate({ subject: 'a'.repeat(300), body: 'b' })).toBe(true);
    expect(withTemplate({ subject: 'a'.repeat(301), body: 'b' })).toBe(false);
    expect(withTemplate({ body: 'b'.repeat(20_000) })).toBe(true);
    expect(withTemplate({ body: 'b'.repeat(20_001) })).toBe(false);
  });

  it('defaults inactivity excludeEvents to []', () => {
    const parsed = zRuleDefinition.parse({
      ...valid,
      goal: { kind: 'inactivity' },
    });
    expect(parsed.goal).toEqual({ kind: 'inactivity', excludeEvents: [] });
  });

  it('rejects a delay or cooldown above 90 days', () => {
    const step = valid.steps[0]!;
    const tooLong = MAX_DELAY_SECONDS + 1;
    expect(
      zRuleDefinition.safeParse({
        ...valid,
        steps: [{ ...step, delaySeconds: tooLong }],
      }).success
    ).toBe(false);
    expect(
      zRuleDefinition.safeParse({
        ...valid,
        reentry: { enabled: true, cooldownSeconds: tooLong },
      }).success
    ).toBe(false);
    expect(
      zRuleDefinition.safeParse({
        ...valid,
        steps: [{ ...step, delaySeconds: MAX_DELAY_SECONDS }],
      }).success
    ).toBe(true);
  });

  describe('step messages', () => {
    const step = valid.steps[0]!;
    const withStep = (patch: Record<string, unknown>) =>
      zRuleDefinition.safeParse({
        ...valid,
        steps: [{ delaySeconds: 60, channel: 'email', ...patch }],
      }).success;

    it('a step with only state variants parses', () => {
      expect(withStep({ variants: { karnataka: { body: 'hi' } } })).toBe(true);
    });

    it('a step with neither template nor variants is rejected', () => {
      expect(withStep({})).toBe(false);
    });

    it('a variant with templateId and no body parses', () => {
      expect(
        withStep({
          variants: {
            a: { templateId: '6f1c1f3e-7a55-4a8e-9c0e-3b1f2d4a5b6c' },
          },
        })
      ).toBe(true);
    });

    it('a template with neither body nor templateId is rejected', () => {
      expect(withStep({ template: { subject: 's' } })).toBe(false);
    });

    it('41 variants are rejected', () => {
      const variants = Object.fromEntries(
        Array.from({ length: 41 }, (_, i) => [`k${i}`, { body: 'x' }])
      );
      expect(withStep({ variants })).toBe(false);
      expect(
        withStep({
          variants: Object.fromEntries(Object.entries(variants).slice(0, 40)),
        })
      ).toBe(true);
    });

    it('an existing starter rule still parses unchanged', () => {
      expect(withStep({ template: step.template })).toBe(true);
    });
  });
});
