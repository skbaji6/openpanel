import { describe, expect, it } from 'bun:test';
import { sanitizeText } from './sanitize';

describe('sanitizeText', () => {
  it('removes NUL characters', () => {
    expect(sanitizeText('a\u0000b\u0000')).toBe('ab');
  });

  it('replaces a lone high surrogate with U+FFFD', () => {
    expect(sanitizeText('x\uD800y')).toBe('x�y');
    expect(sanitizeText('x\uD800')).toBe('x�');
  });

  it('replaces a lone low surrogate with U+FFFD', () => {
    expect(sanitizeText('\uDC00y')).toBe('�y');
  });

  it('keeps a valid surrogate pair', () => {
    expect(sanitizeText('ok 😀')).toBe('ok 😀');
  });
});
