import type {
  ProviderTemplateChannel,
  TemplateInput,
} from './campaign-contract';

const FLOW_ID = /^[A-Za-z0-9]{1,64}$/;
const SENDER_ID = /^[A-Z]{6}$/;
const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
const NAMESPACE = /^[A-Za-z0-9_-]{1,128}$/;
const LANGUAGE = /^[a-z]{2,3}(_[A-Z]{2})?$/;
const INTEGRATED_NUMBER = /^[0-9]{8,15}$/;
const SMS_SLOT = /^[A-Za-z][A-Za-z0-9_]{0,29}$/;
const WHATSAPP_SLOT = /^(header|body|button)_[1-9][0-9]?$/;
const BODY_SLOT = /^body_([1-9][0-9]?)$/;
const NUMBERED_PLACEHOLDER = /\{\{(\d+)\}\}/g;
const CANONICAL_NUMBER = /^[1-9][0-9]?$/;
const ANY_PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const PROFILE_PLACEHOLDER = /^profile\.([A-Za-z0-9_]+)$/;
const MAX_VARIABLES = 20;
const MAX_VALUE_LENGTH = 500;
const MAX_APPROVED_TEXT_LENGTH = 4096;
const MAX_DISPLAY_NAME_LENGTH = 200;
const MAPPING_MESSAGE =
  'Every {{1}}, {{2}}... in the approved text needs a body_1, body_2... variable and the other way round';

export interface TemplateProblem {
  path: string;
  message: string;
}

export function emptyTemplate(channel: ProviderTemplateChannel): TemplateInput {
  const providerRef =
    channel === 'sms'
      ? { flowId: '' }
      : { templateName: '', namespace: '', language: 'en' };
  return {
    channel,
    displayName: '',
    category: 'promotional',
    providerRef,
    approvedText: '',
    variables: [],
  };
}

export function whatsappSlotsFor(approvedText: string): string[] {
  const numbers = new Set(
    [...approvedText.matchAll(NUMBERED_PLACEHOLDER)].map((m) => Number(m[1]))
  );
  return [...numbers].sort((a, b) => a - b).map((n) => `body_${n}`);
}

// Keeps the values already typed for body slots that still exist; header and button rows stay as they are.
export function syncWhatsappVariables(
  approvedText: string,
  current: TemplateInput['variables']
): TemplateInput['variables'] {
  const typed = new Map(current.map((v) => [v.slot, v.value]));
  const generated = whatsappSlotsFor(approvedText).map((slot) => ({
    slot,
    value: typed.get(slot) ?? '',
  }));
  return [...generated, ...current.filter((v) => !BODY_SLOT.test(v.slot))];
}

export function traitsOf(variables: TemplateInput['variables']): string[] {
  const traits = new Set<string>();
  for (const variable of variables) {
    for (const match of variable.value.matchAll(ANY_PLACEHOLDER)) {
      const trait = PROFILE_PLACEHOLDER.exec((match[1] ?? '').trim())?.[1];
      if (trait) {
        traits.add(trait);
      }
    }
  }
  return [...traits];
}

function refOf(input: TemplateInput): Record<string, string | undefined> {
  return input.providerRef as Record<string, string | undefined>;
}

function providerProblems(input: TemplateInput): TemplateProblem[] {
  const ref = refOf(input);
  const problems: TemplateProblem[] = [];
  const check = (
    key: string,
    pattern: RegExp,
    message: string,
    optional = false
  ) => {
    const value = ref[key] ?? '';
    if (optional && value === '') {
      return;
    }
    if (!pattern.test(value)) {
      problems.push({ path: `providerRef.${key}`, message });
    }
  };
  if (input.channel === 'sms') {
    check('flowId', FLOW_ID, 'Flow ID is letters and digits only');
    check('senderId', SENDER_ID, 'Sender ID is six capital letters', true);
    return problems;
  }
  check(
    'templateName',
    TEMPLATE_NAME,
    'Template name is lower-case letters, digits and underscores'
  );
  check('namespace', NAMESPACE, 'Namespace is letters, digits, - and _');
  check('language', LANGUAGE, 'Language is a code such as en or en_US');
  check(
    'integratedNumber',
    INTEGRATED_NUMBER,
    'Integrated number is 8 to 15 digits',
    true
  );
  return problems;
}

function mappingMatches(input: TemplateInput): boolean {
  const numbers = [...input.approvedText.matchAll(NUMBERED_PLACEHOLDER)].map(
    (m) => m[1] ?? ''
  );
  if (!numbers.every((n) => CANONICAL_NUMBER.test(n))) {
    return false;
  }
  const placeholders = new Set(numbers.map(Number));
  const slots = new Set(
    input.variables.flatMap((v) => {
      const n = BODY_SLOT.exec(v.slot)?.[1];
      return n ? [Number(n)] : [];
    })
  );
  return (
    placeholders.size === slots.size &&
    [...placeholders].every((n) => slots.has(n))
  );
}

function variableProblems(input: TemplateInput): TemplateProblem[] {
  const problems: TemplateProblem[] = [];
  const slotPattern = input.channel === 'sms' ? SMS_SLOT : WHATSAPP_SLOT;
  const seen = new Set<string>();
  for (const [index, variable] of input.variables.entries()) {
    const slotPath = `variables.${index}.slot`;
    const valuePath = `variables.${index}.value`;
    if (!slotPattern.test(variable.slot)) {
      problems.push({
        path: slotPath,
        message: `"${variable.slot}" is not a valid variable name`,
      });
    } else if (seen.has(variable.slot)) {
      problems.push({
        path: slotPath,
        message: `"${variable.slot}" is used twice`,
      });
    }
    seen.add(variable.slot);
    const onlyProfile = [...variable.value.matchAll(ANY_PLACEHOLDER)].every(
      (m) => PROFILE_PLACEHOLDER.test((m[1] ?? '').trim())
    );
    if (!onlyProfile) {
      problems.push({
        path: valuePath,
        message: 'Use only {{profile.<trait>}} placeholders and plain text',
      });
    }
    if (variable.value.length > MAX_VALUE_LENGTH) {
      problems.push({
        path: valuePath,
        message: `At most ${MAX_VALUE_LENGTH} characters`,
      });
    }
  }
  return problems;
}

export function templateProblems(input: TemplateInput): TemplateProblem[] {
  const problems: TemplateProblem[] = [];
  const nameLength = input.displayName.trim().length;
  if (nameLength === 0 || nameLength > MAX_DISPLAY_NAME_LENGTH) {
    problems.push({
      path: 'displayName',
      message: `Name is required, at most ${MAX_DISPLAY_NAME_LENGTH} characters`,
    });
  }
  const textLength = input.approvedText.length;
  if (textLength === 0 || textLength > MAX_APPROVED_TEXT_LENGTH) {
    problems.push({
      path: 'approvedText',
      message: `Approved text is required, at most ${MAX_APPROVED_TEXT_LENGTH} characters`,
    });
  }
  problems.push(...providerProblems(input));
  if (input.variables.length > MAX_VARIABLES) {
    problems.push({
      path: 'variables',
      message: `At most ${MAX_VARIABLES} variables`,
    });
  }
  problems.push(...variableProblems(input));
  if (input.channel === 'whatsapp' && !mappingMatches(input)) {
    problems.push({ path: 'approvedText', message: MAPPING_MESSAGE });
  }
  return problems;
}

export function toTemplateBody(form: TemplateInput): TemplateInput {
  const kept = Object.fromEntries(
    Object.entries(refOf(form)).filter(
      ([, value]) => value !== undefined && value !== ''
    )
  );
  return {
    ...form,
    displayName: form.displayName.trim(),
    providerRef: kept as TemplateInput['providerRef'],
  };
}
