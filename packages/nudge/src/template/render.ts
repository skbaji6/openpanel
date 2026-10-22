const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
// Bounds the look-behind so rendering stays linear on huge templates.
const TAG_LOOKBEHIND = 2000;
const URL_ATTRIBUTE_OPEN =
  /\b(?:href|src|srcset|action|formaction|poster)\s*=\s*(?:"[^"]*|'[^']*|[^\s"'>]*)$/i;

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

// A '<' further back than the look-behind window is treated as plain text.
const isInsideUrlAttribute = (template: string, offset: number) => {
  const before = template.slice(Math.max(0, offset - TAG_LOOKBEHIND), offset);
  const tagStart = before.lastIndexOf('<');
  return tagStart !== -1 && URL_ATTRIBUTE_OPEN.test(before.slice(tagStart));
};

const resolve = (
  path: string,
  vars: RenderVars,
  inUrlAttribute: () => boolean
) => {
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
    if (!vars.allowedEventProps.includes(key) || inUrlAttribute()) {
      return '';
    }
    return toText(ownValue(vars.event, key));
  }
  return '';
};

export function renderTemplate(template: string, vars: RenderVars): string {
  return template.replace(
    PLACEHOLDER,
    (_match: string, rawPath: string, offset: number) =>
      escapeHtml(
        resolve(rawPath.trim(), vars, () =>
          isInsideUrlAttribute(template, offset)
        )
      )
  );
}
