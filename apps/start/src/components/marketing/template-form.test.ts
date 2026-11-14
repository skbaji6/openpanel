import { describe, expect, test } from 'vitest';
import type { TemplateInput } from './campaign-contract';
import {
  emptyTemplate,
  templateProblems,
  toTemplateBody,
  traitsOf,
  whatsappSlotsFor,
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
