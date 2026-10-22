const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

// Stands in for a placeholder while the template is tokenized. It is valid in
// text and in attribute values, so placeholders never change the structure.
const PLACEHOLDER_STAND_IN = '';

// Any open or close tag of these elements makes every {{event.*}} in the
// template render empty: raw-text, RCDATA, foreign-content and
// resource/navigation elements whose parsing rules differ from plain HTML.
const FAIL_CLOSED_ELEMENTS = new Set([
  'script',
  'iframe',
  'noscript',
  'xmp',
  'noembed',
  'noframes',
  'plaintext',
  'textarea',
  'title',
  'svg',
  'math',
  'template',
  'object',
  'embed',
  'meta',
  'base',
  'link',
  'form',
  'select',
  'frameset',
  'frame',
  'applet',
  'image',
  'isindex',
]);

const NAME = '[A-Za-z][A-Za-z0-9]*';
const ATTRIBUTE =
  '[A-Za-z_:][A-Za-z0-9_:.-]*(?:=(?:"[^"<>]*"|\'[^\'<>]*\'|[^\\s"\'=<>`]+))?';
const OPEN_TAG = new RegExp(`<(${NAME})(?:\\s+${ATTRIBUTE})*\\s*/?>`, 'y');
const CLOSE_TAG = new RegExp(`</(${NAME})\\s*>`, 'y');
const STYLE_CLOSE_START = /<\/style/gi;
const STYLE_CLOSE_TAG = /<\/style\s*>/iy;
// A stand-in counts as markup start: a value right after '<' could become one.
const MARKUP_START = /[A-Za-z/!?]/;

interface RenderVars {
  profile: Record<string, unknown>;
  event: Record<string, unknown>;
  missing: string[];
  allowedEventProps: string[];
}

interface Analysis {
  failClosed: boolean;
  // Sorted, non-overlapping [start, end) ranges that are not plain text.
  nonText: [number, number][];
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

const FAILED: Analysis = { failClosed: true, nonText: [] };

const isWellFormedComment = (content: string) =>
  !(
    content.includes('<!--') ||
    content.includes('--!>') ||
    content.endsWith('-')
  );

// Strict-grammar tokenizer, one forward pass. Only plain text, simple tags,
// well-formed comments and closed <style> elements are understood; anything
// else starting a markup construct fails the whole template closed.
const analyze = (html: string): Analysis => {
  const nonText: [number, number][] = [];
  let i = html.indexOf('<');
  while (i !== -1) {
    const next = html[i + 1];
    if (next === undefined || !MARKUP_START.test(next)) {
      i = html.indexOf('<', i + 1);
      continue;
    }
    let end: number;
    if (next === '!') {
      const contentStart = i + 4;
      if (
        !html.startsWith('<!--', i) ||
        /^-?>/.test(html.slice(contentStart, contentStart + 2))
      ) {
        return FAILED;
      }
      const close = html.indexOf('-->', contentStart);
      if (
        close === -1 ||
        !isWellFormedComment(html.slice(contentStart, close))
      ) {
        return FAILED;
      }
      end = close + 3;
    } else if (next === '/') {
      CLOSE_TAG.lastIndex = i;
      const tag = CLOSE_TAG.exec(html);
      if (!tag || FAIL_CLOSED_ELEMENTS.has((tag[1] ?? '').toLowerCase())) {
        return FAILED;
      }
      end = i + tag[0].length;
    } else if (next === '?') {
      return FAILED;
    } else {
      OPEN_TAG.lastIndex = i;
      const tag = OPEN_TAG.exec(html);
      const name = (tag?.[1] ?? '').toLowerCase();
      if (!tag || FAIL_CLOSED_ELEMENTS.has(name)) {
        return FAILED;
      }
      end = i + tag[0].length;
      if (name === 'style') {
        STYLE_CLOSE_START.lastIndex = end;
        const closeStart = STYLE_CLOSE_START.exec(html);
        if (!closeStart) {
          return FAILED;
        }
        STYLE_CLOSE_TAG.lastIndex = closeStart.index;
        const closeTag = STYLE_CLOSE_TAG.exec(html);
        if (!closeTag) {
          return FAILED;
        }
        end = closeStart.index + closeTag[0].length;
      }
    }
    nonText.push([i, end]);
    i = html.indexOf('<', end);
  }
  return { failClosed: false, nonText };
};

// Whether each placeholder, in order, sits in plain text of a template the
// tokenizer fully understands.
const placeholderIsPlainText = (template: string): boolean[] => {
  const offsets: number[] = [];
  let shrink = 0;
  const skeleton = template.replace(
    PLACEHOLDER,
    (match: string, _path: string, offset: number) => {
      offsets.push(offset - shrink);
      shrink += match.length - PLACEHOLDER_STAND_IN.length;
      return PLACEHOLDER_STAND_IN;
    }
  );
  const { failClosed, nonText } = analyze(skeleton);
  let range = 0;
  return offsets.map((offset) => {
    while (range < nonText.length && (nonText[range]?.[1] ?? 0) <= offset) {
      range++;
    }
    const current = nonText[range];
    return !(failClosed || (current && current[0] <= offset));
  });
};

const resolve = (path: string, vars: RenderVars, inPlainText: boolean) => {
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
    if (!(inPlainText && vars.allowedEventProps.includes(key))) {
      return '';
    }
    return toText(ownValue(vars.event, key));
  }
  return '';
};

// profile and missing are trusted server-synced sources; never pass raw
// attacker-controlled data as `profile`. event.* values (attacker-controlled)
// render only in plain text of a template the strict tokenizer fully
// understands; otherwise they render empty.
export function renderTemplate(template: string, vars: RenderVars): string {
  const plainText = placeholderIsPlainText(template);
  let index = 0;
  return template.replace(PLACEHOLDER, (_match: string, rawPath: string) =>
    escapeHtml(resolve(rawPath.trim(), vars, plainText[index++] ?? false))
  );
}
