const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const RAW_TEXT_ELEMENTS = new Set([
  'style',
  'script',
  'iframe',
  'noembed',
  'noframes',
  'xmp',
  'noscript',
]);
const SCANNER_PLACEHOLDER = /\{\{([^{}]*)\}\}/y;
const TAG_OPEN = /<(\/?)([A-Za-z][^\s/>]*)/y;

interface RenderVars {
  profile: Record<string, unknown>;
  event: Record<string, unknown>;
  missing: string[];
  allowedEventProps: string[];
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);

const toText = (value: unknown) => {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value);
  }
  return '';
};

const ownValue = (source: Record<string, unknown>, key: string) =>
  FORBIDDEN_KEYS.has(key) || !Object.hasOwn(source, key)
    ? undefined
    : source[key];

const resolve = (path: string, vars: RenderVars, inText: boolean) => {
  if (path === 'missing') {
    return vars.missing.join(', ');
  }
  const dot = path.indexOf('.');
  if (dot === -1) {
    return '';
  }
  const scope = path.slice(0, dot);
  const key = path.slice(dot + 1);
  if (scope === 'profile') {
    return toText(ownValue(vars.profile, key));
  }
  if (scope === 'event') {
    if (!(inText && vars.allowedEventProps.includes(key))) {
      return '';
    }
    return toText(ownValue(vars.event, key));
  }
  return '';
};

type Context = 'text' | 'tag' | 'comment' | 'raw';

// profile and missing are trusted server-synced sources; never pass raw
// attacker-controlled data as `profile`. event.* values (attacker-controlled)
// render only in plain text, never inside a tag, comment or raw-text element.
// One forward scan keeps this linear. The scanner over-approximates tags
// (any quote opens a quoted value), so it errs towards rendering empty.
export function renderTemplate(template: string, vars: RenderVars): string {
  const out: string[] = [];
  const length = template.length;
  let context: Context = 'text';
  let quote = '';
  let tagName = '';
  let closing = false;
  let rawClose = /$^/y;
  let copied = 0;
  let i = 0;
  while (i < length) {
    const char = template[i];
    if (char === '{' && template[i + 1] === '{') {
      SCANNER_PLACEHOLDER.lastIndex = i;
      const match = SCANNER_PLACEHOLDER.exec(template);
      if (match) {
        out.push(
          template.slice(copied, i),
          escapeHtml(resolve(match[1]?.trim() ?? '', vars, context === 'text'))
        );
        i += match[0].length;
        copied = i;
        continue;
      }
    }
    if (context === 'text' && char === '<') {
      if (template.startsWith('<!--', i)) {
        context = 'comment';
        i += 4;
        continue;
      }
      TAG_OPEN.lastIndex = i;
      const tag = TAG_OPEN.exec(template);
      if (tag) {
        context = 'tag';
        quote = '';
        closing = tag[1] === '/';
        tagName = (tag[2] ?? '').toLowerCase();
        i += tag[0].length;
        continue;
      }
    } else if (context === 'comment' && template.startsWith('-->', i)) {
      context = 'text';
      i += 3;
      continue;
    } else if (context === 'tag') {
      if (quote) {
        quote = char === quote ? '' : quote;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        context = !closing && RAW_TEXT_ELEMENTS.has(tagName) ? 'raw' : 'text';
        if (context === 'raw') {
          rawClose = new RegExp(`</${tagName}(?=[\\s/>])`, 'iy');
        }
      }
    } else if (context === 'raw' && char === '<') {
      rawClose.lastIndex = i;
      if (rawClose.test(template)) {
        context = 'text';
        continue;
      }
    }
    i++;
  }
  out.push(template.slice(copied));
  return out.join('');
}
