import { describeMarketingError, MarketingApiError } from './api';
import type { TemplateRow } from './campaign-contract';
import type { JourneyField, Rule, RuleDefinition } from './contract';
import { labelErrorCode } from './error-labels';

export type StartWarning =
  | 'no_default_variant'
  | 'unconfirmed_trigger'
  | 'unconfirmed_goal'
  | 'state_trait_required';

const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;

const START_WARNING_LABELS: Record<StartWarning, string> = {
  unconfirmed_trigger:
    'The trigger event was guessed from the workbook. Confirm it before starting.',
  unconfirmed_goal:
    'The goal event was guessed from the workbook. Confirm it before starting.',
  no_default_variant:
    'A step has state messages but no default. Students with any other state get nothing at that step.',
  state_trait_required:
    'Some steps depend on the student state. The audience API must send the state trait for every student.',
};

const FIELD_LABELS: Record<JourneyField, string> = {
  trigger: 'trigger event',
  goal: 'goal event',
};

const PIN_FAILURE_CODES = new Set([
  'template_not_found',
  'template_disabled',
  'template_channel_mismatch',
  'unknown_variant',
]);

export const labelStartWarning = (warning: StartWarning): string =>
  START_WARNING_LABELS[warning];

export function describeGoal(definition: RuleDefinition): string {
  const { goal } = definition;
  if (goal.kind === 'inactivity') {
    return 'the profile stays inactive';
  }
  if (goal.kind === 'set') {
    return `${goal.event} covers every ${goal.property}`;
  }
  return goal.event;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

function formatDelay(seconds: number): string {
  if (seconds === 0) {
    return 'immediately';
  }
  if (seconds % SECONDS_PER_DAY === 0) {
    return `after ${plural(seconds / SECONDS_PER_DAY, 'day')}`;
  }
  if (seconds % SECONDS_PER_HOUR === 0) {
    return `after ${plural(seconds / SECONDS_PER_HOUR, 'hour')}`;
  }
  return `after ${plural(Math.round(seconds / SECONDS_PER_MINUTE), 'minute')}`;
}

type StepMessage = NonNullable<RuleDefinition['steps'][number]['template']>;

function describeRef(
  ref: StepMessage,
  templates: TemplateRow[]
): string | null {
  if (ref.templateId === undefined) {
    return null;
  }
  const name =
    templates.find((row) => row.templateId === ref.templateId)?.displayName ??
    'Unknown template';
  return ref.version === undefined
    ? `${name} (version fixed at start)`
    : `${name} v${ref.version}`;
}

export function describeStart(rule: Rule, templates: TemplateRow[]) {
  const { definition } = rule;
  const unconfirmed = rule.unconfirmed ?? [];
  const steps = definition.steps.map((step) => {
    const variants = Object.keys(step.variants ?? {});
    const refs = [step.template, ...Object.values(step.variants ?? {})]
      .map((message) => (message ? describeRef(message, templates) : null))
      .filter((ref): ref is string => ref !== null);
    const template = [...new Set(refs)].join(', ');
    return {
      delay: formatDelay(step.delaySeconds),
      channel: step.channel,
      variants,
      hasDefault: step.template !== undefined,
      ...(template ? { template } : {}),
    };
  });
  const warnings: StartWarning[] = [];
  if (unconfirmed.includes('trigger')) {
    warnings.push('unconfirmed_trigger');
  }
  if (unconfirmed.includes('goal')) {
    warnings.push('unconfirmed_goal');
  }
  if (steps.some((step) => step.variants.length > 0 && !step.hasDefault)) {
    warnings.push('no_default_variant');
  }
  if (steps.some((step) => step.variants.length > 0)) {
    warnings.push('state_trait_required');
  }
  return {
    reactsTo: definition.trigger.event,
    filters: (definition.trigger.filters ?? []).map(
      (filter) => `${filter.property} = ${filter.equals}`
    ),
    goal: describeGoal(definition),
    steps,
    warnings,
  };
}

export function startErrorMessage(error: unknown): string {
  if (!(error instanceof MarketingApiError)) {
    return describeMarketingError(error);
  }
  const { details } = error;
  if (error.code === 'journey_unconfirmed') {
    const fields = Array.isArray(details?.fields) ? details.fields : [];
    const names = fields
      .map((field) => FIELD_LABELS[field as JourneyField] ?? String(field))
      .join(' and ');
    return `Confirm the ${names} first, or edit them in the journey editor.`;
  }
  if (
    PIN_FAILURE_CODES.has(error.code) &&
    typeof details?.stepIndex === 'number'
  ) {
    return `Step ${details.stepIndex + 1}, ${String(details.variant)}: ${labelErrorCode(error.code)}`;
  }
  return describeMarketingError(error);
}
