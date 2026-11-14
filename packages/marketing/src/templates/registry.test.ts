import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { HttpError } from '../api/http';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { createTemplateRegistry } from './registry';

const CTX = { projectId: 'p1', userId: 'u1' };
const OTHER = { projectId: 'p2', userId: 'u2' };
const NOW = new Date('2026-11-03T10:00:00.000Z');

const registry = createTemplateRegistry({ sql, now: () => NOW });

const SMS = {
  channel: 'sms' as const,
  displayName: 'Welcome',
  category: 'service' as const,
  providerRef: { flowId: 'abc123' },
  approvedText: 'Hi {#var#}',
  variables: [{ slot: 'var1', value: '{{profile.firstName}}' }],
};

const WHATSAPP = {
  channel: 'whatsapp' as const,
  displayName: 'Order',
  category: 'service' as const,
  providerRef: {
    templateName: 'order_update',
    namespace: 'ns_1',
    language: 'en_US',
  },
  approvedText: 'Hi {{1}}, order {{2}} shipped',
  variables: [
    { slot: 'body_1', value: '{{profile.firstName}}' },
    { slot: 'body_2', value: '{{profile.orderId}}' },
  ],
};

async function rejection(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    return error as HttpError;
  }
  throw new Error('expected a rejection');
}

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await resetMarketingTables();
});

describe('template registry', () => {
  it('create stores version 1 enabled', async () => {
    const row = await registry.create(CTX, SMS);
    expect(row).toMatchObject({
      projectId: 'p1',
      channel: 'sms',
      enabled: true,
      currentVersion: 1,
      version: 1,
      createdBy: 'u1',
      approvedText: 'Hi {#var#}',
    });
    expect((await registry.list('p1', 'sms')).map((r) => r.templateId)).toEqual(
      [row.templateId]
    );
  });

  it('update creates version 2 and getVersion(1) still returns the old text', async () => {
    const created = await registry.create(CTX, SMS);
    const updated = await registry.update(
      CTX,
      created.templateId,
      { ...SMS, approvedText: 'Hello {#var#}' },
      1
    );
    expect(updated.currentVersion).toBe(2);
    expect(updated.approvedText).toBe('Hello {#var#}');
    const old = await registry.getVersion('p1', created.templateId, 1);
    expect(old.approvedText).toBe('Hi {#var#}');
  });

  it('a stale expectedVersion is version_conflict', async () => {
    const created = await registry.create(CTX, SMS);
    await registry.update(CTX, created.templateId, SMS, 1);
    const error = await rejection(
      registry.update(CTX, created.templateId, SMS, 1)
    );
    expect(error.code).toBe('version_conflict');
    expect(error.status).toBe(409);
  });

  it('whatsapp text with {{1}} {{2}} and only body_1 is mapping_mismatch', async () => {
    const error = await rejection(
      registry.create(CTX, {
        ...WHATSAPP,
        variables: [{ slot: 'body_1', value: '{{profile.firstName}}' }],
      })
    );
    expect(error.code).toBe('mapping_mismatch');
  });

  it('a body_3 without {{3}} is mapping_mismatch', async () => {
    const error = await rejection(
      registry.create(CTX, {
        ...WHATSAPP,
        variables: [
          ...WHATSAPP.variables,
          { slot: 'body_3', value: '{{profile.x}}' },
        ],
      })
    );
    expect(error.code).toBe('mapping_mismatch');
  });

  it('a non-canonical {{01}} is mapping_mismatch', async () => {
    const error = await rejection(
      registry.create(CTX, {
        ...WHATSAPP,
        approvedText: 'Hi {{1}} {{01}}',
        variables: [{ slot: 'body_1', value: '{{profile.firstName}}' }],
      })
    );
    expect(error.code).toBe('mapping_mismatch');
  });

  it('getVersion with NaN, 1.5, 0 or 2**31 is not_found', async () => {
    const created = await registry.create(CTX, SMS);
    for (const version of [Number.NaN, 1.5, 0, 2 ** 31]) {
      const error = await rejection(
        registry.getVersion('p1', created.templateId, version)
      );
      expect(error.code).toBe('not_found');
    }
  });

  it("setEnabled on another project's template is not_found", async () => {
    const created = await registry.create(CTX, SMS);
    const error = await rejection(
      registry.setEnabled(OTHER, created.templateId, false)
    );
    expect(error.code).toBe('not_found');
    expect((await registry.get('p1', created.templateId)).enabled).toBe(true);
  });

  it("a whatsapp slot 'button_1' is accepted", async () => {
    const row = await registry.create(CTX, {
      ...WHATSAPP,
      variables: [
        ...WHATSAPP.variables,
        { slot: 'button_1', value: '{{profile.orderId}}' },
      ],
    });
    expect(row.variables).toHaveLength(3);
  });

  it("an sms slot 'var-1' and a whatsapp slot 'body_0' are rejected", async () => {
    const sms = await rejection(
      registry.create(CTX, {
        ...SMS,
        variables: [{ slot: 'var-1', value: 'x' }],
      })
    );
    const whatsapp = await rejection(
      registry.create(CTX, {
        ...WHATSAPP,
        variables: [{ slot: 'body_0', value: 'x' }],
      })
    );
    expect(sms.code).toBe('invalid_body');
    expect(whatsapp.code).toBe('invalid_body');
  });

  it("odd slot names like '{{0}}', '0', 'body_01' and '1var' are rejected", async () => {
    const attempts = [
      { ...SMS, slot: '{{0}}' },
      { ...SMS, slot: '1var' },
      { ...WHATSAPP, slot: '{{0}}' },
      { ...WHATSAPP, slot: '0' },
      { ...WHATSAPP, slot: 'body_01' },
    ];
    for (const { slot, ...template } of attempts) {
      const error = await rejection(
        registry.create(CTX, {
          ...template,
          variables: [{ slot, value: 'x' }],
        })
      );
      expect([slot, error.code]).toEqual([slot, 'invalid_body']);
    }
  });

  it('a value with {{event.x}} is rejected', async () => {
    const error = await rejection(
      registry.create(CTX, {
        ...SMS,
        variables: [{ slot: 'var1', value: '{{event.x}}' }],
      })
    );
    expect(error.code).toBe('invalid_body');
  });

  it('readiness of a disabled template is template_disabled', async () => {
    const created = await registry.create(CTX, SMS);
    await registry.setEnabled(CTX, created.templateId, false);
    expect(await registry.readiness('p1', created.templateId)).toEqual({
      ok: false,
      code: 'template_disabled',
    });
  });

  it('readiness of an enabled template returns its current version', async () => {
    const created = await registry.create(CTX, SMS);
    const result = await registry.readiness('p1', created.templateId);
    expect(result.ok && result.channel).toBe('sms');
    expect(result.ok && result.version.version).toBe(1);
  });

  it('readiness of a whatsapp version edited outside the API is template_mapping_missing', async () => {
    const created = await registry.create(CTX, WHATSAPP);
    await sql.$executeRawUnsafe(
      `INSERT INTO marketing.message_template_versions (template_id, version, display_name, category, provider_ref, approved_text, variables, created_by)
       SELECT template_id, 2, display_name, category, provider_ref, approved_text, '[]'::jsonb, created_by
       FROM marketing.message_template_versions WHERE template_id = $1::uuid AND version = 1`,
      created.templateId
    );
    await sql.$executeRawUnsafe(
      'UPDATE marketing.message_templates SET current_version = 2 WHERE id = $1::uuid',
      created.templateId
    );
    expect(await registry.readiness('p1', created.templateId)).toEqual({
      ok: false,
      code: 'template_mapping_missing',
    });
  });

  it("another project's template is not_found", async () => {
    const created = await registry.create(CTX, SMS);
    expect((await rejection(registry.get('p2', created.templateId))).code).toBe(
      'not_found'
    );
    expect(
      (await rejection(registry.getVersion('p2', created.templateId, 1))).code
    ).toBe('not_found');
    expect(
      (await rejection(registry.update(OTHER, created.templateId, SMS, 1))).code
    ).toBe('not_found');
    expect(await registry.readiness('p2', created.templateId)).toEqual({
      ok: false,
      code: 'template_not_found',
    });
    expect(await registry.list('p2')).toEqual([]);
  });

  it('a non-uuid id is not_found', async () => {
    expect((await rejection(registry.get('p1', 'nope'))).code).toBe(
      'not_found'
    );
    expect(await registry.readiness('p1', 'nope')).toEqual({
      ok: false,
      code: 'template_not_found',
    });
  });

  it('changing channel is channel_immutable', async () => {
    const created = await registry.create(CTX, SMS);
    const error = await rejection(
      registry.update(CTX, created.templateId, WHATSAPP, 1)
    );
    expect(error.code).toBe('channel_immutable');
    expect(error.status).toBe(400);
  });
});
