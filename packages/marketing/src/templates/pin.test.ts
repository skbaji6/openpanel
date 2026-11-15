import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import type { RuleDefinition, Step } from '../rules/rule.schema';
import { pinDefinition } from './pin';
import { createTemplateRegistry } from './registry';

const CTX = { projectId: 'p1', userId: 'u1' };
const registry = createTemplateRegistry({ sql, now: () => new Date() });

const PUSH = {
  channel: 'push' as const,
  displayName: 'Nudge',
  category: 'service' as const,
  content: { subject: 'Hello', body: 'Come back' },
};

const definition = (steps: Step[]): RuleDefinition => ({
  name: 'j',
  trigger: { event: 'signup' },
  goal: { kind: 'event', event: 'paid' },
  steps,
  reentry: { enabled: false, cooldownSeconds: 0 },
  allowedEventProps: [],
});

beforeAll(async () => {
  await migrate();
});
beforeEach(async () => {
  await resetMarketingTables();
});

describe('pinDefinition', () => {
  it('an unversioned push ref pins the current version and copies its text', async () => {
    const t = await registry.create(CTX, PUSH);
    const result = await pinDefinition(
      registry,
      'p1',
      definition([
        {
          delaySeconds: 0,
          channel: 'push',
          template: { templateId: t.templateId },
          variants: { TS: { templateId: t.templateId } },
        },
      ])
    );
    expect(result).toMatchObject({
      ok: true,
      pinned: [
        {
          stepIndex: 0,
          variant: 'default',
          templateId: t.templateId,
          version: 1,
        },
        { stepIndex: 0, variant: 'TS', templateId: t.templateId, version: 1 },
      ],
    });
    if (!result.ok) {
      return;
    }
    expect(result.definition.steps[0]?.template).toEqual({
      templateId: t.templateId,
      version: 1,
      subject: 'Hello',
      body: 'Come back',
    });
    expect(result.definition.steps[0]?.variants?.TS?.body).toBe('Come back');
  });

  it('a versioned ref keeps its version after the template changes', async () => {
    const t = await registry.create(CTX, PUSH);
    await registry.update(
      CTX,
      t.templateId,
      { ...PUSH, content: { body: 'New text' } },
      1
    );
    const result = await pinDefinition(
      registry,
      'p1',
      definition([
        {
          delaySeconds: 0,
          channel: 'push',
          template: { templateId: t.templateId, version: 1 },
        },
      ])
    );
    expect(result.ok && result.definition.steps[0]?.template?.body).toBe(
      'Come back'
    );
  });

  it('a disabled template refuses with template_disabled and the step index', async () => {
    const t = await registry.create(CTX, PUSH);
    await registry.setEnabled(CTX, t.templateId, false);
    const result = await pinDefinition(
      registry,
      'p1',
      definition([
        { delaySeconds: 0, channel: 'push', template: { body: 'x' } },
        {
          delaySeconds: 5,
          channel: 'push',
          template: { templateId: t.templateId },
        },
      ])
    );
    expect(result).toEqual({
      ok: false,
      code: 'template_disabled',
      stepIndex: 1,
      variant: 'default',
    });
  });

  it('a versioned ref on a disabled template refuses with template_disabled', async () => {
    const t = await registry.create(CTX, PUSH);
    await registry.setEnabled(CTX, t.templateId, false);
    const result = await pinDefinition(
      registry,
      'p1',
      definition([
        {
          delaySeconds: 0,
          channel: 'push',
          template: { templateId: t.templateId, version: 1 },
        },
      ])
    );
    expect(result).toEqual({
      ok: false,
      code: 'template_disabled',
      stepIndex: 0,
      variant: 'default',
    });
  });

  it('a push template on an email step is template_channel_mismatch', async () => {
    const t = await registry.create(CTX, PUSH);
    const result = await pinDefinition(
      registry,
      'p1',
      definition([
        {
          delaySeconds: 0,
          channel: 'email',
          template: { templateId: t.templateId },
        },
      ])
    );
    expect(result).toMatchObject({
      ok: false,
      code: 'template_channel_mismatch',
    });
  });

  it('inline messages are returned unchanged', async () => {
    const def = definition([
      { delaySeconds: 0, channel: 'push', template: { body: 'x' } },
    ]);
    const result = await pinDefinition(registry, 'p1', def);
    expect(result).toEqual({ ok: true, definition: def, pinned: [] });
  });
});
