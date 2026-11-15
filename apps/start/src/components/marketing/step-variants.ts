import {
  MAX_VARIANT_KEY_LENGTH,
  MAX_VARIANTS,
  type Step,
  type StepTemplate,
} from './contract';

export const DEFAULT_VARIANT = 'default';

export function variantKeys(step: Step): string[] {
  const keys = Object.keys(step.variants ?? {}).sort();
  return step.template ? [DEFAULT_VARIANT, ...keys] : keys;
}

export function messageFor(step: Step, key: string): StepTemplate | undefined {
  if (key === DEFAULT_VARIANT) {
    return step.template;
  }
  return step.variants?.[key];
}

// A step with no message at all would fail the schema, so the last message cannot be removed.
export function setMessage(
  step: Step,
  key: string,
  message: StepTemplate | undefined
): Step {
  if (message === undefined && variantKeys(step).length <= 1) {
    return step;
  }
  const { template, variants, ...rest } = step;
  if (key === DEFAULT_VARIANT) {
    return {
      ...rest,
      ...(variants ? { variants } : {}),
      ...(message ? { template: message } : {}),
    };
  }
  const { [key]: _removed, ...others } = variants ?? {};
  const nextVariants = message ? { ...others, [key]: message } : others;
  return {
    ...rest,
    ...(template ? { template } : {}),
    ...(Object.keys(nextVariants).length > 0 ? { variants: nextVariants } : {}),
  };
}

export function copyMessage(step: Step, from: string, to: string): Step {
  const source = messageFor(step, from);
  if (!source || from === to) {
    return step;
  }
  return setMessage(step, to, structuredClone(source));
}

export function coverage(
  steps: Step[],
  states: string[]
): { state: string; missingSteps: number[] }[] {
  return states.map((state) => ({
    state,
    missingSteps: steps.flatMap((step, index) =>
      step.template || step.variants?.[state] ? [] : [index]
    ),
  }));
}

function stepRange(indexes: number[]): string {
  const ranges: string[] = [];
  let start = 0;
  while (start < indexes.length) {
    let end = start;
    while (indexes[end + 1] === (indexes[end] ?? 0) + 1) {
      end += 1;
    }
    const first = (indexes[start] ?? 0) + 1;
    const last = (indexes[end] ?? 0) + 1;
    ranges.push(first === last ? `${first}` : `${first}-${last}`);
    start = end + 1;
  }
  return ranges.join(', ');
}

export function describeCoverage(
  entries: { state: string; missingSteps: number[] }[]
): string {
  return entries
    .map(({ state, missingSteps }) =>
      missingSteps.length === 0
        ? `${state}: all steps`
        : `${state}: no message in step${missingSteps.length === 1 ? '' : 's'} ${stepRange(missingSteps)}`
    )
    .join('; ');
}

// The next start pins the newest version of the template and copies its text again.
export function unpinLatest(message: StepTemplate): StepTemplate {
  if (message.templateId === undefined) {
    return message;
  }
  return { templateId: message.templateId };
}

export function variantKeyProblem(step: Step, raw: string): string | null {
  const key = raw.trim();
  if (key === '') {
    return 'Enter a state value';
  }
  if (key.length > MAX_VARIANT_KEY_LENGTH) {
    return `At most ${MAX_VARIANT_KEY_LENGTH} characters`;
  }
  if (key === DEFAULT_VARIANT) {
    return '"default" is the message for every other state';
  }
  if (step.variants?.[key]) {
    return 'There is already a message for that state';
  }
  if (Object.keys(step.variants ?? {}).length >= MAX_VARIANTS) {
    return `At most ${MAX_VARIANTS} state messages per step`;
  }
  return null;
}

// Messages with no text and no template would be sent empty.
export function emptyMessages(steps: Step[]): string[] {
  return steps.flatMap((step, index) =>
    variantKeys(step).flatMap((key) => {
      const message = messageFor(step, key);
      const isEmpty =
        message !== undefined &&
        message.templateId === undefined &&
        (message.body ?? '').trim() === '';
      return isEmpty ? [`Step ${index + 1}, ${key}: the message is empty`] : [];
    })
  );
}

export interface InlineContent {
  subject?: string;
  body: string;
}

export function inlineContent(content: unknown): InlineContent | null {
  if (typeof content !== 'object' || content === null) {
    return null;
  }
  const { subject, body } = content as Record<string, unknown>;
  if (typeof body !== 'string') {
    return null;
  }
  return typeof subject === 'string' ? { subject, body } : { body };
}

// A pinned reference carries a copy of its text; an unpinned one shows the template's newest content.
export function resolveMessage(
  message: StepTemplate,
  template: { content?: unknown } | undefined
): InlineContent | null {
  if (message.body !== undefined) {
    return message.subject === undefined
      ? { body: message.body }
      : { subject: message.subject, body: message.body };
  }
  return template ? inlineContent(template.content) : null;
}

const SAMPLE_STATE = 'sample state';
const SAMPLE_PROFILE = { firstName: 'Ada', email: 'ada@example.com' };
const SAMPLE_MISSING = ['Section 2', 'Section 5'];

// The route accepts only { subject?, body } as the template; ids, versions and text never go with it.
export function previewRequest(
  step: Pick<Step, 'channel'>,
  content: InlineContent,
  tab: string,
  allowedEventProps: string[]
) {
  const hasSubject = step.channel !== 'webhook' && Boolean(content.subject);
  return {
    channel: step.channel,
    template: hasSubject
      ? { subject: content.subject, body: content.body }
      : { body: content.body },
    allowedEventProps,
    sample: {
      profile: {
        ...SAMPLE_PROFILE,
        state: tab === DEFAULT_VARIANT ? SAMPLE_STATE : tab,
      },
      event: Object.fromEntries(
        allowedEventProps.map((property) => [property, `sample ${property}`])
      ),
      missing: SAMPLE_MISSING,
    },
  };
}
