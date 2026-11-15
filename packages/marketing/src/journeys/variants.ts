import type { Step, StepTemplate } from '../rules/rule.schema';

export const STATE_TRAIT = 'state';
export const DEFAULT_VARIANT_KEY = 'default';

// variantKey is the operator's configured key, never the student's state value.
export type MessageChoice =
  | { ok: true; variantKey: string; template: StepTemplate & { body: string } }
  | {
      ok: false;
      variantKey: string;
      reason: 'no_state_trait' | 'no_variant_for_state' | 'template_not_pinned';
    };

function stateOf(traits: Record<string, unknown>): string {
  const value = traits[STATE_TRAIT];
  const isUsable = typeof value === 'string' || typeof value === 'number';
  return isUsable ? String(value).trim() : '';
}

// Operators type keys by hand, so " ts " and "TS" must reach the same students; an exact key still wins.
function variantKeyFor(
  variants: Record<string, StepTemplate>,
  state: string
): string | undefined {
  if (Object.hasOwn(variants, state)) {
    return state;
  }
  const wanted = state.toLowerCase();
  return Object.keys(variants).find(
    (candidate) => candidate.trim().toLowerCase() === wanted
  );
}

function pinned(template: StepTemplate, variantKey: string): MessageChoice {
  const { body } = template;
  if (body === undefined) {
    return { ok: false, variantKey, reason: 'template_not_pinned' };
  }
  return { ok: true, variantKey, template: { ...template, body } };
}

export function chooseMessage(
  step: Step,
  traits: Record<string, unknown>
): MessageChoice {
  const variants = step.variants ?? {};
  const state = stateOf(traits);
  const key = state === '' ? undefined : variantKeyFor(variants, state);
  const variant = key === undefined ? undefined : variants[key];
  if (key !== undefined && variant) {
    return pinned(variant, key);
  }
  if (step.template) {
    return pinned(step.template, DEFAULT_VARIANT_KEY);
  }
  return {
    ok: false,
    variantKey: '',
    reason: state === '' ? 'no_state_trait' : 'no_variant_for_state',
  };
}
