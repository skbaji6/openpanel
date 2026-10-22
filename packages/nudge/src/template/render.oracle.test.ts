import { describe, expect, it } from 'bun:test';
import { parse } from 'parse5';
import { renderTemplate } from './render';

const SENTINEL = 'ZZSENTINELZZ';
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const NON_TEXT_PARENTS = new Set([
  'script',
  'style',
  'iframe',
  'noscript',
  'textarea',
  'title',
  'xmp',
  'noembed',
  'noframes',
  'plaintext',
  'template',
]);
const FUZZ_TEMPLATES = 2000;
const LCG_MODULUS = 4_294_967_296;
const LCG_SEED = 20_261_022;

interface Node5 {
  nodeName: string;
  namespaceURI?: string;
  value?: string;
  name?: string;
  publicId?: string;
  systemId?: string;
  data?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Node5[];
  content?: Node5;
}

const render = (template: string) =>
  renderTemplate(template, {
    profile: {},
    event: { x: SENTINEL, url: SENTINEL, h: SENTINEL, title: SENTINEL },
    missing: [],
    allowedEventProps: ['x', 'url', 'h', 'title'],
  });

// Returns where the sentinel is found when it is somewhere other than a text
// node of an ordinary HTML element, plus whether it appeared as text at all.
const inspect = (html: string, scriptingEnabled: boolean) => {
  const leaks: string[] = [];
  let sawText = false;
  const walk = (node: Node5, parent?: Node5) => {
    const parentName = parent?.nodeName ?? '';
    if (node.nodeName === '#text') {
      const hasSentinel = (node.value ?? '').includes(SENTINEL);
      const safe =
        parent?.namespaceURI === HTML_NAMESPACE &&
        !NON_TEXT_PARENTS.has(parentName);
      if (hasSentinel && safe) {
        sawText = true;
      } else if (hasSentinel) {
        leaks.push(`text in <${parentName}>`);
      }
    } else if (node.nodeName === '#comment' && node.data?.includes(SENTINEL)) {
      leaks.push('comment');
    } else if (
      node.nodeName === '#documentType' &&
      [node.name, node.publicId, node.systemId].join(' ').includes(SENTINEL)
    ) {
      leaks.push('doctype');
    }
    for (const attr of node.attrs ?? []) {
      if (attr.name.includes(SENTINEL) || attr.value.includes(SENTINEL)) {
        leaks.push(`attribute ${attr.name} on <${node.nodeName}>`);
      }
    }
    if (node.nodeName.includes(SENTINEL.toLowerCase())) {
      leaks.push('tag name');
    }
    for (const child of node.childNodes ?? []) {
      walk(child, node);
    }
    if (node.content) {
      walk(node.content, node);
    }
  };
  walk(parse(html, { scriptingEnabled }) as unknown as Node5);
  return { leaks, sawText };
};

const assertNoLeak = (template: string) => {
  const html = render(template);
  for (const scriptingEnabled of [true, false]) {
    const { leaks } = inspect(html, scriptingEnabled);
    if (leaks.length > 0) {
      throw new Error(
        `leak (${leaks.join(', ')}) for template ${JSON.stringify(template)} -> ${JSON.stringify(html)}`
      );
    }
  }
  return inspect(html, true).sawText;
};

const longStyle = `<a style="${'color:red;'.repeat(210)}" href="{{event.url}}">x</a>`;
const longHref = `<a href="https://x.test/?${'a'.repeat(2000)}&u={{event.url}}">`;

const REPROS: string[] = [
  // F1
  longStyle,
  longHref,
  // F2
  '<a href="/s?q=a<b&u={{event.url}}">',
  // F3
  '<div style="background:url({{event.url}})">',
  '<style>a{background:url({{event.url}})}</style>',
  '<td background="{{event.url}}">',
  '<object data="{{event.url}}">',
  '<meta http-equiv="refresh" content="0;url={{event.url}}">',
  // F4
  '<iframe srcdoc="{{event.h}}">',
  '<a onclick="{{event.url}}">',
  '<script>var u = "{{event.url}}"</script>',
  // N1
  `<a b'="'>" href="{{event.url}}">x</a>`,
  `<a b=x'y c="'>" href="{{event.url}}">x</a>`,
  `<title><x '</title><a b="'>" href="{{event.url}}">x</a>`,
  // N2
  '<script><!--<script></script>var u={{event.x}};</script>',
  // N3
  '<![CDATA[ {{event.x}} ]]>',
  '<?php {{event.x}} ?>',
  '</ {{event.x}}>',
  '<!DOCTYPE {{event.x}}>',
  // assorted
  '<!-- {{event.x}} -->',
  '<a href={{event.url}}>',
  '<a {{event.x}}>',
  '<p>ok {{event.x}}</p>',
  '<!-->{{event.x}}',
  '<!--->{{event.x}}',
  '<!-- a --!>{{event.x}}',
  '<svg><desc>{{event.x}}</desc></svg>',
  '<textarea>{{event.x}}</textarea>',
  '<plaintext>{{event.x}}',
];

const FRAGMENTS = [
  '<a ',
  'href=',
  '"',
  "'",
  '>',
  '<',
  '<!--',
  '-->',
  '--!>',
  '<script>',
  '</script>',
  '<style>',
  '</style>',
  '<![CDATA[',
  ']]>',
  '<?x',
  '</ ',
  '</',
  '<!DOCTYPE ',
  '{{event.x}}',
  '{{event.x}}',
  '{{event.url}}',
  'text',
  ' ',
  '\n',
  '=',
  '/',
  '-',
  '<svg>',
  '</svg>',
  '<title>',
  '</title>',
  '<textarea>',
  '<iframe ',
  '<noscript>',
  '<b>',
  '</b>',
  '<p>',
  'b=c ',
  "b'=",
  'style=',
  '<math>',
  '<template>',
  '<select>',
  '<!-',
  '&lt;',
  '<a href="x">',
  '</a>',
  '<!-- c -->',
  '<style>a{}</style>',
  '<br>',
  '<img src=x alt="y">',
  '<b>',
  'text',
  'text',
  '{{event.x}}',
  '{{event.x}}',
];

const lcg = (seed: number) => {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % LCG_MODULUS;
    return state / LCG_MODULUS;
  };
};

describe('renderTemplate differential oracle (parse5)', () => {
  it('never lets the event value out of plain text for known repros', () => {
    for (const template of REPROS) {
      assertNoLeak(template);
    }
  });

  it('still renders the value in plain text (the oracle is not vacuous)', () => {
    expect(assertNoLeak('<p>hi {{event.x}}</p>')).toBe(true);
    expect(assertNoLeak('<!-- c --><b>{{event.x}}</b>')).toBe(true);
    expect(assertNoLeak('<style>a{}</style>{{event.x}}')).toBe(true);
  });

  it(`holds for ${FUZZ_TEMPLATES} seeded random templates`, () => {
    const random = lcg(LCG_SEED);
    let rendered = 0;
    for (let n = 0; n < FUZZ_TEMPLATES; n++) {
      const count = 3 + Math.floor(random() * 10);
      let template = '';
      for (let k = 0; k < count; k++) {
        template += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)];
      }
      if (assertNoLeak(template)) {
        rendered++;
      }
    }
    // Guards against a renderer that blanks everything.
    expect(rendered).toBeGreaterThan(50);
  });
});
