import { describe, expect, it } from 'bun:test';
import { renderTemplate } from './render';

const TEXT = { mode: 'text' } as const;

const vars = (over: Partial<Parameters<typeof renderTemplate>[1]> = {}) => ({
  profile: { firstName: 'Ada' },
  event: {},
  missing: [],
  allowedEventProps: [],
  ...over,
});

describe('renderTemplate text mode', () => {
  it('does not HTML-escape values', () => {
    expect(
      renderTemplate(
        '{{profile.firstName}}: {{event.title}} ({{missing}})',
        vars({
          profile: { firstName: `O'Hara & <Co>` },
          event: { title: '"<b>"' },
          missing: ['a&b'],
          allowedEventProps: ['title'],
        }),
        TEXT
      )
    ).toBe(`O'Hara & <Co>: "<b>" (a&b)`);
  });

  it('renders event values regardless of surrounding markup', () => {
    expect(
      renderTemplate(
        '<script>{{event.title}}',
        vars({ event: { title: 'X' }, allowedEventProps: ['title'] }),
        TEXT
      )
    ).toBe('<script>X');
  });

  it('still enforces allowedEventProps', () => {
    expect(
      renderTemplate(
        'x{{event.secret}}y',
        vars({ event: { secret: 'S' }, allowedEventProps: ['title'] }),
        TEXT
      )
    ).toBe('xy');
  });

  it('renders prototype and unknown names empty', () => {
    const template =
      '[{{profile.__proto__}}][{{profile.constructor}}][{{event.toString}}][{{unknown.x}}][{{nope}}]';
    expect(
      renderTemplate(
        template,
        vars({ allowedEventProps: ['toString', '__proto__'] }),
        TEXT
      )
    ).toBe('[][][][][]');
  });

  it('replaces control characters in values so a value cannot add a header line', () => {
    expect(
      renderTemplate(
        'Hi {{event.name}}',
        vars({
          event: { name: 'a\r\nBcc: x@evil.test\u0007' },
          allowedEventProps: ['name'],
        }),
        TEXT
      )
    ).toBe('Hi a  Bcc: x@evil.test ');
  });

  it('defaults to html mode', () => {
    expect(
      renderTemplate(
        '{{profile.firstName}}',
        vars({ profile: { firstName: '<' } })
      )
    ).toBe('&lt;');
    expect(
      renderTemplate(
        '{{profile.firstName}}',
        vars({ profile: { firstName: '<' } }),
        { mode: 'html' }
      )
    ).toBe('&lt;');
  });
});
