import { describe, expect, test } from 'vitest';
import { MAX_VARIANTS, type Step } from './contract';
import {
  copyMessage,
  coverage,
  DEFAULT_VARIANT,
  describeCoverage,
  emptyMessages,
  inlineContent,
  messageFor,
  previewRequest,
  resolveMessage,
  setMessage,
  unpinLatest,
  variantKeyProblem,
  variantKeys,
} from './step-variants';

const step = (patch: Partial<Step> = {}): Step => ({
  delaySeconds: 0,
  channel: 'push',
  ...patch,
});

describe('variantKeys', () => {
  test('keys list default first', () => {
    const value = step({
      template: { body: 'd' },
      variants: { TS: { body: 't' }, AP: { body: 'a' } },
    });
    expect(variantKeys(value)).toEqual([DEFAULT_VARIANT, 'AP', 'TS']);
    expect(variantKeys(step({ variants: { TS: { body: 't' } } }))).toEqual([
      'TS',
    ]);
  });
});

describe('setMessage', () => {
  test('removing the last message is refused', () => {
    const only = step({ template: { body: 'd' } });
    expect(setMessage(only, DEFAULT_VARIANT, undefined)).toBe(only);
    const onlyVariant = step({ variants: { TS: { body: 't' } } });
    expect(setMessage(onlyVariant, 'TS', undefined)).toBe(onlyVariant);
  });

  test('removing one of several messages works and drops an empty variants map', () => {
    const value = step({
      template: { body: 'd' },
      variants: { TS: { body: 't' } },
    });
    const result = setMessage(value, 'TS', undefined);
    expect(result.variants).toBeUndefined();
    expect(result.template).toEqual({ body: 'd' });
    expect(
      setMessage(value, DEFAULT_VARIANT, undefined).template
    ).toBeUndefined();
  });

  test('sets default and variant messages', () => {
    const result = setMessage(step({ template: { body: 'd' } }), 'AP', {
      body: 'a',
    });
    expect(messageFor(result, 'AP')).toEqual({ body: 'a' });
    expect(messageFor(result, DEFAULT_VARIANT)).toEqual({ body: 'd' });
  });
});

describe('copyMessage', () => {
  test('copy TS to AP', () => {
    const value = step({ variants: { TS: { subject: 's', body: 't' } } });
    const result = copyMessage(value, 'TS', 'AP');
    expect(result.variants?.AP).toEqual({ subject: 's', body: 't' });
    expect(result.variants?.AP).not.toBe(result.variants?.TS);
  });

  test('copying a missing message changes nothing', () => {
    const value = step({ template: { body: 'd' } });
    expect(copyMessage(value, 'TS', 'AP')).toBe(value);
  });
});

describe('coverage', () => {
  test('coverage reports missing states per step and a default covers all', () => {
    const steps = [
      step({ template: { body: 'd' } }),
      step({ variants: { AP: { body: 'a' } } }),
      step({ variants: { AP: { body: 'a' }, TS: { body: 't' } } }),
    ];
    expect(coverage(steps, ['AP', 'TS'])).toEqual([
      { state: 'AP', missingSteps: [] },
      { state: 'TS', missingSteps: [1] },
    ]);
  });
});

describe('unpinLatest', () => {
  test('unpinLatest drops version and copied text', () => {
    expect(
      unpinLatest({
        templateId: 't1',
        version: 2,
        subject: 's',
        body: 'b',
        text: 'x',
      })
    ).toEqual({ templateId: 't1' });
  });

  test('an inline message is returned unchanged', () => {
    const inline = { body: 'b' };
    expect(unpinLatest(inline)).toBe(inline);
  });
});

describe('variantKeyProblem', () => {
  const value = step({
    template: { body: 'd' },
    variants: { TS: { body: 't' } },
  });

  test('accepts a new trimmed key', () => {
    expect(variantKeyProblem(value, ' AP ')).toBeNull();
  });

  test('refuses empty, reserved, duplicate and long keys', () => {
    expect(variantKeyProblem(value, '  ')).not.toBeNull();
    expect(variantKeyProblem(value, DEFAULT_VARIANT)).not.toBeNull();
    expect(variantKeyProblem(value, 'TS')).not.toBeNull();
    expect(variantKeyProblem(value, 'x'.repeat(65))).not.toBeNull();
  });

  test('refuses the 41st variant', () => {
    const variants = Object.fromEntries(
      Array.from({ length: MAX_VARIANTS }, (_, i) => [`k${i}`, { body: 'b' }])
    );
    expect(variantKeyProblem(step({ variants }), 'extra')).not.toBeNull();
  });
});

describe('describeCoverage', () => {
  test('names the steps each state misses', () => {
    expect(
      describeCoverage([
        { state: 'AP', missingSteps: [] },
        { state: 'KA', missingSteps: [0, 1, 2, 3, 4] },
        { state: 'TS', missingSteps: [1, 3] },
      ])
    ).toBe(
      'AP: all steps; KA: no message in steps 1-5; TS: no message in steps 2, 4'
    );
  });
});

describe('emptyMessages', () => {
  test('lists empty inline messages and ignores template refs', () => {
    const steps = [
      step({
        template: { body: ' ' },
        variants: { TS: { templateId: 't1' }, AP: { body: 'a' } },
      }),
    ];
    expect(emptyMessages(steps)).toEqual([
      'Step 1, default: the message is empty',
    ]);
  });
});

describe('previewRequest', () => {
  test('sends only subject and body and the tab as the sample state', () => {
    const request = previewRequest(
      step({ channel: 'push' }),
      { subject: 'Hi', body: 'Body' },
      'TS',
      ['item']
    );
    expect(request.template).toEqual({ subject: 'Hi', body: 'Body' });
    expect(request.sample.profile.state).toBe('TS');
    expect(request.sample.event).toEqual({ item: 'sample item' });
    expect(JSON.stringify(request)).not.toContain('templateId');
  });

  test('omits an empty subject, and any subject for a webhook', () => {
    expect(
      previewRequest(step(), { subject: '', body: 'b' }, DEFAULT_VARIANT, [])
        .template
    ).toEqual({ body: 'b' });
    expect(
      previewRequest(
        step({ channel: 'webhook' }),
        { subject: 's', body: 'b' },
        'TS',
        []
      ).template
    ).toEqual({ body: 'b' });
  });
});

describe('resolveMessage', () => {
  test('a pinned copy wins over the newest template content', () => {
    expect(
      resolveMessage(
        { templateId: 't', version: 1, subject: 'old', body: 'old body' },
        { content: { body: 'new body' } }
      )
    ).toEqual({ subject: 'old', body: 'old body' });
  });

  test('an unpinned reference shows the template content, or nothing when unknown', () => {
    expect(
      resolveMessage(
        { templateId: 't' },
        { content: { subject: 's', body: 'b' } }
      )
    ).toEqual({ subject: 's', body: 'b' });
    expect(resolveMessage({ templateId: 't' }, undefined)).toBeNull();
    expect(inlineContent({ subject: 1 })).toBeNull();
  });
});
