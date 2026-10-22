import { describe, expect, it } from 'bun:test';
import { MAX_DELAY_SECONDS, zRuleDefinition } from './rule.schema';
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
});
