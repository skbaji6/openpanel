import { describe, expect, it } from 'bun:test';
import type { Step } from '../rules/rule.schema';
import { chooseMessage } from './variants';

const DEFAULT = { subject: 'Hi', body: 'default' };
const TS = { body: 'telangana' };
const AP = { body: 'andhra' };
const UNPINNED_ID = '00000000-0000-4000-8000-000000000001';

function step(overrides: Partial<Step> = {}): Step {
  return { delaySeconds: 0, channel: 'email', ...overrides };
}

describe('chooseMessage', () => {
  it('no variants uses the default', () => {
    expect(chooseMessage(step({ template: DEFAULT }), { state: 'TS' })).toEqual(
      { ok: true, template: DEFAULT }
    );
  });

  it('state TS picks the TS variant', () => {
    const choice = chooseMessage(
      step({ template: DEFAULT, variants: { TS, AP } }),
      { state: 'TS' }
    );
    expect(choice).toEqual({ ok: true, template: TS });
  });

  it('numeric state 36 matches key "36"', () => {
    const choice = chooseMessage(step({ variants: { '36': TS } }), {
      state: 36,
    });
    expect(choice).toEqual({ ok: true, template: TS });
  });

  it('a state with other case and spaces matches the key', () => {
    const choice = chooseMessage(step({ variants: { TS, AP } }), {
      state: '  ap ',
    });
    expect(choice).toEqual({ ok: true, template: AP });
  });

  it('a state named like an object property still gets the default', () => {
    for (const state of ['constructor', '__proto__', 'toString']) {
      const choice = chooseMessage(
        step({ template: DEFAULT, variants: { TS } }),
        { state }
      );
      expect(choice).toEqual({ ok: true, template: DEFAULT });
    }
  });

  it('unknown state falls back to the default', () => {
    const choice = chooseMessage(
      step({ template: DEFAULT, variants: { TS } }),
      { state: 'KA' }
    );
    expect(choice).toEqual({ ok: true, template: DEFAULT });
  });

  it('unknown state and no default is no_variant_for_state', () => {
    expect(chooseMessage(step({ variants: { TS } }), { state: 'KA' })).toEqual({
      ok: false,
      reason: 'no_variant_for_state',
    });
  });

  it('missing state and no default is no_state_trait', () => {
    for (const traits of [{}, { state: '  ' }, { state: { nested: 'TS' } }]) {
      expect(chooseMessage(step({ variants: { TS } }), traits)).toEqual({
        ok: false,
        reason: 'no_state_trait',
      });
    }
  });

  it('a variant with only templateId is template_not_pinned', () => {
    const choice = chooseMessage(
      step({
        template: DEFAULT,
        variants: { TS: { templateId: UNPINNED_ID } },
      }),
      { state: 'TS' }
    );
    expect(choice).toEqual({ ok: false, reason: 'template_not_pinned' });
  });
});
