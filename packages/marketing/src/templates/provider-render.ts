import { renderTemplate } from '../template/render';
import type { TemplateVersion } from './registry';

const MAX_VALUE_LENGTH = 1024;
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const PROFILE_PREFIX = 'profile.';
const SLOT_ORDER = { header: 0, body: 1, button: 2 } as const;
// \s already covers U+2028 and U+2029.
const WHITESPACE_RUN = /\s+/g;

type Traits = Record<string, string | number | boolean>;
interface Variable {
  slot: string;
  value: string;
}

const normalise = (text: string) =>
  text.replace(WHITESPACE_RUN, ' ').trim().slice(0, MAX_VALUE_LENGTH);

// renderTemplate renders an absent trait as '', so absence is checked here first.
const referencedTraits = (value: string) =>
  [...value.matchAll(PLACEHOLDER)].flatMap((match) => {
    const path = (match[1] ?? '').trim();
    return path.startsWith(PROFILE_PREFIX)
      ? [path.slice(PROFILE_PREFIX.length)]
      : [];
  });

function slotRank(slot: string): [number, number] | null {
  const [kind, number] = slot.split('_');
  if (kind && Object.hasOwn(SLOT_ORDER, kind) && number) {
    return [SLOT_ORDER[kind as keyof typeof SLOT_ORDER], Number(number)];
  }
  return null;
}

// Header, body, then button slots by number; sms slot names keep the order given.
function bySlot(a: Variable, b: Variable): number {
  const rankA = slotRank(a.slot);
  const rankB = slotRank(b.slot);
  if (!(rankA && rankB)) {
    return 0;
  }
  return rankA[0] - rankB[0] || rankA[1] - rankB[1];
}

export function renderProviderVariables(
  version: TemplateVersion,
  traits: Traits
):
  | { ok: true; variables: Variable[] }
  | { ok: false; reason: 'missing_variable' } {
  const variables: Variable[] = [];
  for (const variable of version.variables) {
    const allPresent = referencedTraits(variable.value).every((key) =>
      Object.hasOwn(traits, key)
    );
    const value = allPresent
      ? normalise(
          renderTemplate(
            variable.value,
            { profile: traits, event: {}, missing: [], allowedEventProps: [] },
            { mode: 'text' }
          )
        )
      : '';
    if (value === '') {
      return { ok: false, reason: 'missing_variable' };
    }
    variables.push({ slot: variable.slot, value });
  }
  return { ok: true, variables: variables.sort(bySlot) };
}
