import type { Step, StepTemplate } from '../rules/rule.schema';

export const STATE_TRAIT = 'state';

export type MessageChoice =
  | { ok: true; template: StepTemplate & { body: string } }
  | {
      ok: false;
      reason: 'no_state_trait' | 'no_variant_for_state' | 'template_not_pinned';
    };

function stateOf(traits: Record<string, unknown>): string {
  const value = traits[STATE_TRAIT];
  const isUsable = typeof value === 'string' || typeof value === 'number';
  return isUsable ? String(value).trim() : '';
}

// Operators type keys by hand, so " ts " and "TS" must reach the same students; an exact key still wins.
function variantFor(
  variants: Record<string, StepTemplate>,
  state: string
): StepTemplate | undefined {
  const exact = variants[state];
  if (exact) {
    return exact;
  }
  const wanted = state.toLowerCase();
  const key = Object.keys(variants).find(
    (candidate) => candidate.trim().toLowerCase() === wanted
  );
  return key === undefined ? undefined : variants[key];
}

function pinned(template: StepTemplate): MessageChoice {
  const { body } = template;
  if (body === undefined) {
    return { ok: false, reason: 'template_not_pinned' };
  }
  return { ok: true, template: { ...template, body } };
}

export function chooseMessage(
  step: Step,
  traits: Record<string, unknown>
): MessageChoice {
  const variants = step.variants ?? {};
  const state = stateOf(traits);
  const variant = state === '' ? undefined : variantFor(variants, state);
  const chosen = variant ?? step.template;
  if (chosen) {
    return pinned(chosen);
  }
  return {
    ok: false,
    reason: state === '' ? 'no_state_trait' : 'no_variant_for_state',
  };
}
