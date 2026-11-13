import { renderTemplate } from '../template/render';
import type { TemplateVersion } from './registry';

const MAX_VALUE_LENGTH = 1024;
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const PROFILE_PREFIX = 'profile.';
const SLOT_ORDER = { header: 0, body: 1, button: 2 } as const;
// \s already covers U+2028 and U+2029.
const WHITESPACE_RUN = /\s+/g;
const HIGH_SURROGATE_MIN = 0xd8_00;
const HIGH_SURROGATE_MAX = 0xdb_ff;

type Traits = Record<string, string | number | boolean>;
interface Variable {
  slot: string;
  value: string;
}

const collapseWhitespace = (text: string) =>
  text.replace(WHITESPACE_RUN, ' ').trim();

// Cutting between the halves of a surrogate pair would leave a lone surrogate.
function truncate(text: string): string {
  if (text.length <= MAX_VALUE_LENGTH) {
    return text;
  }
  const last = text.charCodeAt(MAX_VALUE_LENGTH - 1);
  const splitsPair = last >= HIGH_SURROGATE_MIN && last <= HIGH_SURROGATE_MAX;
  return text.slice(0, splitsPair ? MAX_VALUE_LENGTH - 1 : MAX_VALUE_LENGTH);
}

// renderTemplate renders an absent trait as '', so absence is checked here first.
const referencedTraits = (value: string) =>
  [...value.matchAll(PLACEHOLDER)].flatMap((match) => {
    const path = (match[1] ?? '').trim();
    return path.startsWith(PROFILE_PREFIX)
      ? [path.slice(PROFILE_PREFIX.length)]
      : [];
  });

const isUsableTrait = (traits: Traits, key: string) =>
  Object.hasOwn(traits, key) && collapseWhitespace(String(traits[key])) !== '';

function slotRank(slot: string): [number, number] | null {
  const [kind, number] = slot.split('_');
  if (kind && Object.hasOwn(SLOT_ORDER, kind) && number) {
    return [SLOT_ORDER[kind as keyof typeof SLOT_ORDER], Number(number)];
  }
  return null;
}

function bySlot(a: Variable, b: Variable): number {
  const rankA = slotRank(a.slot);
  const rankB = slotRank(b.slot);
  if (!(rankA && rankB)) {
    return 0;
  }
  return rankA[0] - rankB[0] || rankA[1] - rankB[1];
}

// The version does not carry its channel, but only a WhatsApp reference has a template name.
const isWhatsApp = (version: TemplateVersion) =>
  typeof version.providerRef === 'object' &&
  version.providerRef !== null &&
  'templateName' in version.providerRef;

export function renderProviderVariables(
  version: TemplateVersion,
  traits: Traits
):
  | { ok: true; variables: Variable[] }
  | { ok: false; reason: 'missing_variable' } {
  const variables: Variable[] = [];
  for (const variable of version.variables) {
    const allUsable = referencedTraits(variable.value).every((key) =>
      isUsableTrait(traits, key)
    );
    const value = allUsable
      ? truncate(
          collapseWhitespace(
            renderTemplate(
              variable.value,
              {
                profile: traits,
                event: {},
                missing: [],
                allowedEventProps: [],
              },
              { mode: 'text' }
            )
          )
        )
      : '';
    if (value === '') {
      return { ok: false, reason: 'missing_variable' };
    }
    variables.push({ slot: variable.slot, value });
  }
  // Slot names in an sms flow are free-form, so only WhatsApp variables are reordered.
  return {
    ok: true,
    variables: isWhatsApp(version) ? variables.sort(bySlot) : variables,
  };
}
