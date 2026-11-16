import { describe, expect, test } from 'vitest';
import type { TemplateInput } from './campaign-contract';
import {
  emptyTemplate,
  nextSlot,
  nextSmsSlot,
  pushTraitsOf,
  syncWhatsappVariables,
  templateProblems,
  toTemplateBody,
  traitsOf,
  whatsappSlotsFor,
  withRowIds,
} from './template-form';

const sms: TemplateInput = {
  channel: 'sms',
  displayName: 'Welcome',
  category: 'service',
  providerRef: { flowId: 'abc123', senderId: 'OPENPL' },
  approvedText: 'Hi ##var1##',
  variables: [{ slot: 'var1', value: '{{profile.first_name}}' }],
};
const whatsapp: TemplateInput = {
  channel: 'whatsapp',
  displayName: 'Offer',
  category: 'promotional',
  providerRef: { templateName: 'offer_1', namespace: 'ns_1', language: 'en' },
  approvedText: 'Hi {{1}}, {{2}}',
  variables: [
    { slot: 'body_1', value: '{{profile.first_name}}' },
    { slot: 'body_2', value: 'today' },
  ],
};

describe('whatsappSlotsFor', () => {
  test('orders and collapses duplicates', () => {
    expect(whatsappSlotsFor('Hi {{2}} {{1}} {{2}}')).toEqual([
      'body_1',
      'body_2',
    ]);
    expect(whatsappSlotsFor('Hi {{1}}, {{2}}')).toEqual(['body_1', 'body_2']);
  });
  test('none', () => {
    expect(whatsappSlotsFor('plain')).toEqual([]);
  });
});

describe('templateProblems', () => {
  test('valid inputs have none', () => {
    expect(templateProblems(sms)).toEqual([]);
    expect(templateProblems(whatsapp)).toEqual([]);
  });
  test('bad sender id', () => {
    const bad = { ...sms, providerRef: { flowId: 'x', senderId: 'abc123' } };
    expect(templateProblems(bad).map((p) => p.path)).toEqual([
      'providerRef.senderId',
    ]);
  });
  test('bad slot and event placeholder', () => {
    const bad = {
      ...whatsapp,
      variables: [{ slot: 'body_0', value: '{{event.x}}' }],
    };
    const paths = templateProblems(bad).map((p) => p.path);
    expect(paths).toContain('variables.0.slot');
    expect(paths).toContain('variables.0.value');
  });
  test('whatsapp mapping mismatch', () => {
    const bad = { ...whatsapp, variables: [{ slot: 'body_1', value: 'a' }] };
    expect(templateProblems(bad).map((p) => p.path)).toContain('approvedText');
  });
  test('empty template reports required fields', () => {
    expect(templateProblems(emptyTemplate('sms')).length).toBeGreaterThan(0);
  });
});

describe('toTemplateBody', () => {
  test('drops empty optional provider fields', () => {
    const body = toTemplateBody({
      ...sms,
      providerRef: { flowId: 'a', senderId: '' },
    });
    expect(body.providerRef).toEqual({ flowId: 'a' });
    const wa = toTemplateBody({
      ...whatsapp,
      providerRef: { ...whatsapp.providerRef, integratedNumber: '' },
    });
    expect(wa.providerRef).not.toHaveProperty('integratedNumber');
  });
});

describe('traitsOf', () => {
  test('collects unique traits', () => {
    expect(
      traitsOf([
        { slot: 'a', value: '{{profile.name}} {{ profile.city }}' },
        { slot: 'b', value: '{{profile.name}}' },
      ])
    ).toEqual(['name', 'city']);
  });
});

describe('toTemplateBody ids', () => {
  test('variables carry only slot and value', () => {
    const body = toTemplateBody({
      ...whatsapp,
      variables: withRowIds(whatsapp.variables),
    });
    expect(body.variables).toEqual(whatsapp.variables);
    for (const variable of body.variables) {
      expect(Object.keys(variable).sort()).toEqual(['slot', 'value']);
    }
  });
});

describe('withRowIds', () => {
  test('gives distinct ids and keeps existing ones', () => {
    const rows = withRowIds([
      { id: 'keep', slot: 'a', value: '' },
      { slot: 'b', value: '' },
      { slot: 'c', value: '' },
    ]);
    expect(rows[0]?.id).toBe('keep');
    expect(new Set(rows.map((r) => r.id)).size).toBe(3);
  });
});

describe('syncWhatsappVariables', () => {
  const current = withRowIds([
    { slot: 'body_1', value: '{{profile.a}}' },
    { slot: 'body_2', value: 'two' },
    { slot: 'header_1', value: 'head' },
  ]);
  const plain = (rows: { slot: string; value: string }[]) =>
    rows.map(({ slot, value }) => ({ slot, value }));
  test('keeps a typed body value and its row id when the text changes', () => {
    const next = syncWhatsappVariables('Hi {{1}} {{2}} more', current);
    expect(plain(next).find((v) => v.slot === 'body_1')?.value).toBe(
      '{{profile.a}}'
    );
    expect(next.find((v) => v.slot === 'body_1')?.id).toBe(current[0]?.id);
  });
  test('drops a removed body slot', () => {
    expect(
      plain(syncWhatsappVariables('Hi {{1}}', current)).map((v) => v.slot)
    ).toEqual(['body_1', 'header_1']);
  });
  test('keeps header_1 and adds new body rows', () => {
    const next = syncWhatsappVariables('{{1}} {{2}} {{3}}', current);
    expect(next.map((v) => v.slot)).toEqual([
      'body_1',
      'body_2',
      'body_3',
      'header_1',
    ]);
    expect(next.every((v) => v.id)).toBe(true);
  });
});

describe('nextSlot', () => {
  test('first free number of the kind', () => {
    expect(nextSlot('header', [])).toBe('header_1');
    expect(
      nextSlot('button', [
        { slot: 'button_1', value: '' },
        { slot: 'button_3', value: '' },
      ])
    ).toBe('button_2');
    expect(nextSlot('header', [{ slot: 'button_1', value: '' }])).toBe(
      'header_1'
    );
  });
});

describe('nextSmsSlot', () => {
  test('first free varN after a removal', () => {
    expect(nextSmsSlot([])).toBe('var1');
    expect(
      nextSmsSlot([
        { slot: 'var1', value: '' },
        { slot: 'var3', value: '' },
      ])
    ).toBe('var2');
  });
});

describe('more templateProblems', () => {
  test('{{01}} is a mapping problem', () => {
    const bad = { ...whatsapp, approvedText: 'Hi {{01}}', variables: [] };
    expect(templateProblems(bad).map((p) => p.path)).toContain('approvedText');
  });
  test('duplicate slot', () => {
    const bad = {
      ...sms,
      variables: [
        { slot: 'var1', value: 'a' },
        { slot: 'var1', value: 'b' },
      ],
    };
    expect(templateProblems(bad).map((p) => p.path)).toContain(
      'variables.1.slot'
    );
  });
  test('21 variables', () => {
    const bad = {
      ...sms,
      variables: Array.from({ length: 21 }, (_, i) => ({
        slot: `v${i}`,
        value: 'x',
      })),
    };
    expect(templateProblems(bad).map((p) => p.path)).toContain('variables');
  });
  test('bad flow id and template name', () => {
    expect(
      templateProblems({ ...sms, providerRef: { flowId: 'a b' } }).map(
        (p) => p.path
      )
    ).toEqual(['providerRef.flowId']);
    expect(
      templateProblems({
        ...whatsapp,
        providerRef: { ...whatsapp.providerRef, templateName: 'Offer 1' },
      }).map((p) => p.path)
    ).toEqual(['providerRef.templateName']);
  });
});

describe('push templates', () => {
  test('an empty push body is a problem', () => {
    const form = emptyTemplate('push');
    expect(form.content).toEqual({ subject: '', body: '' });
    form.displayName = 'Nudge';
    expect(templateProblems(form).map((p) => p.path)).toContain('content.body');
    form.content.body = 'Hello {{profile.firstName}}';
    expect(templateProblems(form)).toEqual([]);
  });

  test('toTemplateBody trims the name and drops an empty title', () => {
    const form = emptyTemplate('push');
    form.displayName = '  Nudge ';
    form.content.body = 'Hi';
    expect(toTemplateBody(form)).toEqual({
      channel: 'push',
      displayName: 'Nudge',
      category: 'promotional',
      content: { body: 'Hi' },
    });
  });

  test('pushTraitsOf lists the traits a push text uses', () => {
    expect(
      pushTraitsOf({
        subject: 'Hi {{profile.firstName}}',
        body: '{{profile.state}} {{profile.state}} {{missing}}',
      })
    ).toEqual(['firstName', 'state']);
  });
});
