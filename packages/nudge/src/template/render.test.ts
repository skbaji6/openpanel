import { describe, expect, it } from 'bun:test';
import { renderTemplate } from './render';

const vars = (over: Partial<Parameters<typeof renderTemplate>[1]> = {}) => ({
  profile: { firstName: 'Ada' },
  event: {},
  missing: [],
  allowedEventProps: [],
  ...over,
});

describe('renderTemplate', () => {
  it('substitutes profile.firstName', () => {
    expect(renderTemplate('Hi {{profile.firstName}}!', vars())).toBe('Hi Ada!');
    expect(renderTemplate('Hi {{ profile.firstName }}!', vars())).toBe(
      'Hi Ada!'
    );
  });

  it('escapes <script> in event.title into &lt;script&gt;', () => {
    const out = renderTemplate(
      '{{event.title}}',
      vars({
        event: { title: `<script>"a"&'b'</script>` },
        allowedEventProps: ['title'],
      })
    );
    expect(out).toBe(
      '&lt;script&gt;&quot;a&quot;&amp;&#39;b&#39;&lt;/script&gt;'
    );
  });

  it('renders empty for event.secret when not in allowedEventProps', () => {
    expect(
      renderTemplate(
        'x{{event.secret}}y',
        vars({ event: { secret: 'S' }, allowedEventProps: ['title'] })
      )
    ).toBe('xy');
  });

  it('renders empty for event.url inside href="{{event.url}}" even when allowlisted', () => {
    const v = vars({
      event: { url: 'javascript:alert(1)' },
      allowedEventProps: ['url'],
    });
    expect(renderTemplate('<a href="{{event.url}}">go</a>', v)).toBe(
      '<a href="">go</a>'
    );
    expect(renderTemplate("<a HREF = '{{event.url}}'>go</a>", v)).toBe(
      "<a HREF = ''>go</a>"
    );
    expect(renderTemplate('<img src={{event.url}}>', v)).toBe('<img src=>');
    expect(renderTemplate('<a href="/p?u={{event.url}}">', v)).toBe(
      '<a href="/p?u=">'
    );
    expect(renderTemplate('<a href="/x">{{event.url}}</a>', v)).toBe(
      '<a href="/x">javascript:alert(1)</a>'
    );
  });

  it('{{missing}} joins "Chapter 4, Chapter 5"', () => {
    expect(
      renderTemplate(
        '{{missing}}',
        vars({ missing: ['Chapter 4', 'Chapter 5'] })
      )
    ).toBe('Chapter 4, Chapter 5');
  });

  it('escapes missing values', () => {
    expect(renderTemplate('{{missing}}', vars({ missing: ['<b>'] }))).toBe(
      '&lt;b&gt;'
    );
  });

  it('unknown placeholder {{constructor}} renders empty and does not throw', () => {
    for (const t of [
      '{{constructor}}',
      '{{__proto__}}',
      '{{profile.__proto__}}',
      '{{profile.constructor}}',
      '{{profile.toString}}',
      '{{event.__proto__}}',
      '{{nope}}',
      '{{}}',
    ]) {
      expect(
        renderTemplate(
          `a${t}b`,
          vars({ allowedEventProps: ['__proto__', 'constructor', 'toString'] })
        )
      ).toBe('ab');
    }
  });

  it('ignores an own __proto__ key from parsed JSON', () => {
    const profile = JSON.parse('{"__proto__":"evil"}') as Record<
      string,
      unknown
    >;
    expect(renderTemplate('{{profile.__proto__}}', vars({ profile }))).toBe('');
  });

  it('does not re-expand substituted values (single pass)', () => {
    expect(
      renderTemplate(
        '{{profile.firstName}}',
        vars({ profile: { firstName: '{{profile.firstName}}' } })
      )
    ).toBe('{{profile.firstName}}');
  });

  it('handles nested placeholders without executing the outer one', () => {
    expect(renderTemplate('{{ {{profile.firstName}} }}', vars())).toBe(
      '{{ Ada }}'
    );
  });

  it('leaves unclosed braces literal', () => {
    expect(renderTemplate('a {{profile.firstName', vars())).toBe(
      'a {{profile.firstName'
    );
    expect(renderTemplate('{{{profile.firstName}}', vars())).toBe('{Ada');
  });

  it('renders non-scalar and null values as empty', () => {
    expect(
      renderTemplate(
        '{{profile.a}}|{{profile.b}}|{{profile.c}}|{{profile.n}}',
        vars({ profile: { a: { x: 1 }, b: null, c: [1], n: 5 } })
      )
    ).toBe('|||5');
  });

  it('renders a very long template in linear time', () => {
    const t = `{{ ${' '.repeat(200_000)}`;
    const long = `${'{{'.repeat(100_000)}${'x'.repeat(500_000)}`;
    const start = performance.now();
    renderTemplate(t, vars());
    renderTemplate(long, vars());
    renderTemplate('{{profile.firstName}}'.repeat(50_000), vars());
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
