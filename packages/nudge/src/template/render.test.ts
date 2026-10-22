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

  describe('event placeholders fail closed outside plain text', () => {
    const v = vars({
      event: { url: 'javascript:alert(1)', h: '<b>', x: 'X', title: '<i>' },
      allowedEventProps: ['url', 'h', 'x', 'title'],
    });
    const url = '{{event.url}}';
    const emptyCases: Record<string, string> = {
      'long style before href': `<a style="${'color:red;'.repeat(210)}" href="${url}">x</a>`,
      'long href value before placeholder': `<a href="https://x.test/?${'a'.repeat(2000)}&u=${url}">`,
      'less-than inside quoted value': `<a href="/s?q=a<b&u=${url}">`,
      'greater-than inside quoted value': `<a title="a>b" href="${url}">`,
      'css url in style attribute': `<div style="background:url(${url})">`,
      'style element': `<style>a{background:url(${url})}</style>`,
      'background attribute': `<td background="${url}">`,
      'object data': `<object data="${url}">`,
      'meta refresh': `<meta http-equiv="refresh" content="0;url=${url}">`,
      'iframe srcdoc': '<iframe srcdoc="{{event.h}}">',
      'onclick handler': `<a onclick="${url}">`,
      'script body': `<script>var u = "${url}"</script>`,
      'unquoted attribute': `<a href=${url}>`,
      'html comment': '<!-- {{event.x}} -->',
      'tag name position': `<a ${url}>`,
      'quote before equals (N1a)': `<a b'="'>" href="${url}">x</a>`,
      'quote inside unquoted value (N1b)': `<a b=x'y c="'>" href="${url}">x</a>`,
      'quote after title (N1c)': `<title><x '</title><a b="'>" href="${url}">x</a>`,
      'double escaped script (N2)':
        '<script><!--<script></script>var u={{event.x}};</script>',
      'cdata (N3)': '<![CDATA[ {{event.x}} ]]>',
      'processing instruction (N3)': '<?php {{event.x}} ?>',
      'bogus end tag (N3)': '</ {{event.x}}>',
      'value completing a tag (oracle)': '<{{event.x}}{{event.x}}href=',
      'doctype (N3)': '<!DOCTYPE {{event.x}}>',
    };
    for (const [name, template] of Object.entries(emptyCases)) {
      it(`renders empty for ${name}`, () => {
        const out = renderTemplate(template, v);
        expect(out).not.toContain('javascript:');
        expect(out).not.toContain('&lt;b&gt;');
        expect(out).not.toMatch(/X(?!\w)/);
      });
    }

    it('fails the whole template closed, even placeholders before the construct', () => {
      expect(renderTemplate('{{event.x}}<?php ?>', v)).toBe('<?php ?>');
      expect(renderTemplate('{{event.x}}<a "bad">', v)).toBe('<a "bad">');
      expect(renderTemplate('{{event.x}}<!-- never closed', v)).toBe(
        '<!-- never closed'
      );
    });

    it('renders escaped values in plain text', () => {
      expect(renderTemplate('<p>{{event.title}}</p>', v)).toBe(
        '<p>&lt;i&gt;</p>'
      );
    });

    it('renders after a closed tag, comment, style and script', () => {
      expect(renderTemplate('<b>ok</b>{{event.x}}', v)).toBe('<b>ok</b>X');
      expect(renderTemplate('<!-- c -->{{event.x}}', v)).toBe('<!-- c -->X');
      expect(renderTemplate('<style>a{}</style>{{event.x}}', v)).toBe(
        '<style>a{}</style>X'
      );
      expect(renderTemplate('<SCRIPT>1</SCRIPT >{{event.x}}', v)).toBe(
        '<SCRIPT>1</SCRIPT >'
      );
      expect(renderTemplate('a < b {{event.x}}', v)).toBe('a < b X');
    });

    it('keeps profile and missing working inside attributes', () => {
      expect(
        renderTemplate(
          '<a href="https://x.test/{{profile.firstName}}?m={{missing}}">',
          vars({ missing: ['a&b'] })
        )
      ).toBe('<a href="https://x.test/Ada?m=a&amp;b">');
    });

    it('stays linear with a very long attribute value before the placeholder', () => {
      const long = `<a title="${'x'.repeat(500_000)}" href="{{event.url}}">${'<a '.repeat(100_000)}`;
      const start = performance.now();
      expect(renderTemplate(long, v)).toContain('href=""');
      expect(performance.now() - start).toBeLessThan(2000);
    });
  });
});
