import { describe, expect, it } from 'bun:test';
import { renderProviderVariables } from './provider-render';
import type { TemplateVersion } from './registry';

const WHATSAPP_REF = { templateName: 't' };
const SMS_REF = { flowId: 'a' };

function version(
  variables: { slot: string; value: string }[],
  providerRef: unknown = WHATSAPP_REF
): TemplateVersion {
  return {
    templateId: 't',
    version: 1,
    displayName: 'x',
    category: 'service',
    providerRef,
    approvedText: 'x',
    variables,
    createdBy: 'u',
    createdAt: '2026-11-03T10:00:00.000Z',
  };
}

const render = (
  variables: { slot: string; value: string }[],
  traits: Record<string, string | number | boolean>,
  providerRef: unknown = WHATSAPP_REF
) => renderProviderVariables(version(variables, providerRef), traits);

describe('renderProviderVariables', () => {
  it('fills body_1 from {{profile.firstName}}', () => {
    expect(
      render([{ slot: 'body_1', value: 'Hi {{profile.firstName}}' }], {
        firstName: 'Ada',
      })
    ).toEqual({ ok: true, variables: [{ slot: 'body_1', value: 'Hi Ada' }] });
  });

  it('a missing trait is missing_variable', () => {
    expect(
      render([{ slot: 'body_1', value: '{{profile.firstName}}' }], {})
    ).toEqual({ ok: false, reason: 'missing_variable' });
  });

  it("a value 'A\\nB\\t\\tC     D' renders 'A B C D'", () => {
    const result = render([{ slot: 'body_1', value: '{{profile.t}}' }], {
      t: 'A\nB\t\tC     D',
    });
    expect(result).toEqual({
      ok: true,
      variables: [{ slot: 'body_1', value: 'A B C D' }],
    });
  });

  it('a trait of only spaces is missing_variable', () => {
    expect(
      render([{ slot: 'body_1', value: '{{profile.t}}' }], { t: ' \n  ' })
    ).toEqual({ ok: false, reason: 'missing_variable' });
  });

  it('slots come out header_1, body_1, body_2, body_10, button_1', () => {
    const slots = ['button_1', 'body_10', 'body_2', 'header_1', 'body_1'];
    const result = render(
      slots.map((slot) => ({ slot, value: 'v' })),
      {}
    );
    expect(result.ok && result.variables.map((v) => v.slot)).toEqual([
      'header_1',
      'body_1',
      'body_2',
      'body_10',
      'button_1',
    ]);
  });

  it('sms variables keep the order given', () => {
    const result = render(
      [
        { slot: 'var2', value: 'b' },
        { slot: 'var1', value: 'a' },
      ],
      {},
      SMS_REF
    );
    expect(result.ok && result.variables.map((v) => v.slot)).toEqual([
      'var2',
      'var1',
    ]);
  });

  it('a 2,000-character trait is cut to 1,024', () => {
    const result = render([{ slot: 'body_1', value: '{{profile.t}}' }], {
      t: 'x'.repeat(2000),
    });
    expect(result.ok && result.variables[0]?.value.length).toBe(1024);
  });

  it('a trait that looks like {{profile.x}} is not re-expanded', () => {
    const result = render([{ slot: 'body_1', value: '{{profile.t}}' }], {
      t: '{{profile.x}}',
      x: 'secret',
    });
    expect(result).toEqual({
      ok: true,
      variables: [{ slot: 'body_1', value: '{{profile.x}}' }],
    });
  });

  it('sms slots [var2, body_1, var1] keep the order given', () => {
    const result = render(
      ['var2', 'body_1', 'var1'].map((slot) => ({ slot, value: 'v' })),
      {},
      SMS_REF
    );
    expect(result.ok && result.variables.map((v) => v.slot)).toEqual([
      'var2',
      'body_1',
      'var1',
    ]);
  });

  it('a blank trait next to literal text is missing_variable', () => {
    for (const firstName of ['  ', '']) {
      expect(
        render([{ slot: 'body_1', value: 'Hi {{profile.firstName}}' }], {
          firstName,
        })
      ).toEqual({ ok: false, reason: 'missing_variable' });
    }
  });

  it('a cut never leaves half of a surrogate pair', () => {
    const result = render([{ slot: 'body_1', value: '{{profile.t}}' }], {
      t: `${'x'.repeat(1023)}\u{1F600}tail`,
    });
    expect(result.ok && result.variables[0]?.value).toBe('x'.repeat(1023));
  });
});
