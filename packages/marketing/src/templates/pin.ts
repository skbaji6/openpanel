import { HttpError } from '../api/http';
import {
  type RuleDefinition,
  type Step,
  type StepTemplate,
  zInlineTemplate,
} from '../rules/rule.schema';
import { compileEmailContent, zEmailContent } from './email-blocks';
import type { createTemplateRegistry } from './registry';

type TemplateRegistry = ReturnType<typeof createTemplateRegistry>;

export const DEFAULT_VARIANT = 'default';

export interface PinnedRef {
  stepIndex: number;
  variant: string;
  templateId: string;
  version: number;
}

type PinFailureCode =
  | 'template_not_found'
  | 'template_disabled'
  | 'template_channel_mismatch';

export type PinResult =
  | { ok: true; definition: RuleDefinition; pinned: PinnedRef[] }
  | {
      ok: false;
      code: PinFailureCode;
      stepIndex: number;
      variant: string;
    };

type MessageResult =
  | { ok: true; message: StepTemplate; version: number }
  | { ok: false; code: PinFailureCode };

async function pinMessage(
  registry: TemplateRegistry,
  projectId: string,
  channel: Step['channel'],
  message: StepTemplate
): Promise<MessageResult> {
  const { templateId } = message;
  if (templateId === undefined) {
    return { ok: true, message, version: 0 };
  }
  try {
    const template = await registry.get(projectId, templateId);
    if (!template.enabled) {
      return { ok: false, code: 'template_disabled' };
    }
    const isPushPair = template.channel === 'push' && channel === 'push';
    const isEmailPair = template.channel === 'email' && channel === 'email';
    if (!(isPushPair || isEmailPair)) {
      return { ok: false, code: 'template_channel_mismatch' };
    }
    const version = await registry.getVersion(
      projectId,
      templateId,
      message.version ?? template.currentVersion
    );
    if (isEmailPair) {
      const compiled = compileEmailContent(
        zEmailContent.parse(version.content)
      );
      return {
        ok: true,
        version: version.version,
        message: { templateId, version: version.version, ...compiled },
      };
    }
    const content = zInlineTemplate.parse(version.content);
    return {
      ok: true,
      version: version.version,
      message: {
        templateId,
        version: version.version,
        subject: content.subject,
        body: content.body,
        ...(message.text === undefined ? {} : { text: message.text }),
      },
    };
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return { ok: false, code: 'template_not_found' };
    }
    throw error;
  }
}

export async function pinDefinition(
  registry: TemplateRegistry,
  projectId: string,
  definition: RuleDefinition
): Promise<PinResult> {
  const pinned: PinnedRef[] = [];
  const steps: Step[] = [];
  for (const [stepIndex, step] of definition.steps.entries()) {
    const pinOne = async (
      variant: string,
      message: StepTemplate
    ): Promise<MessageResult> => {
      const result = await pinMessage(
        registry,
        projectId,
        step.channel,
        message
      );
      if (result.ok && message.templateId !== undefined) {
        pinned.push({
          stepIndex,
          variant,
          templateId: message.templateId,
          version: result.version,
        });
      }
      return result;
    };
    const next: Step = { ...step };
    if (step.template) {
      const result = await pinOne(DEFAULT_VARIANT, step.template);
      if (!result.ok) {
        return {
          ok: false,
          code: result.code,
          stepIndex,
          variant: DEFAULT_VARIANT,
        };
      }
      next.template = result.message;
    }
    if (step.variants) {
      const variants: Record<string, StepTemplate> = {};
      for (const [variant, message] of Object.entries(step.variants)) {
        const result = await pinOne(variant, message);
        if (!result.ok) {
          return { ok: false, code: result.code, stepIndex, variant };
        }
        variants[variant] = result.message;
      }
      next.variants = variants;
    }
    steps.push(next);
  }
  return { ok: true, definition: { ...definition, steps }, pinned };
}

const PIN_FAILURE_STATUS = 409;

export async function pinOrThrow(
  registry: TemplateRegistry,
  projectId: string,
  definition: RuleDefinition
): Promise<{ definition: RuleDefinition; pinned: PinnedRef[] }> {
  const result = await pinDefinition(registry, projectId, definition);
  if (!result.ok) {
    throw new HttpError(PIN_FAILURE_STATUS, result.code, undefined, {
      stepIndex: result.stepIndex,
      variant: result.variant,
    });
  }
  return { definition: result.definition, pinned: result.pinned };
}
