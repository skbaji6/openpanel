import { describe, expect, it } from 'bun:test';
import { renderTemplate } from '../template/render';
import { compileEmailContent, zEmailContent } from './email-blocks';

const vars = (event: Record<string, unknown> = {}) => ({
  profile: { name: 'Ada' },
  event,
  missing: [],
  allowedEventProps: ['course'],
});
const content = (blocks: unknown[]) => ({ subject: 'Hi', blocks });
const parse = (blocks: unknown[]) => zEmailContent.parse(content(blocks));

describe('email blocks', () => {
  it('a paragraph with <script> is escaped in body and plain in text', () => {
    const compiled = compileEmailContent(
      parse([{ type: 'paragraph', text: '<script>alert(1)</script> & co' }])
    );
    expect(compiled.body).not.toContain('<script');
    expect(compiled.body).toContain(
      '&lt;script&gt;alert(1)&lt;/script&gt; &amp; co'
    );
    expect(compiled.text).toBe('<script>alert(1)</script> & co');
  });

  it('a profile placeholder renders the trait through renderTemplate html mode', () => {
    const { body } = compileEmailContent(
      parse([{ type: 'heading', text: 'Hi {{profile.name}}' }])
    );
    expect(renderTemplate(body, vars(), { mode: 'html' })).toContain('Hi Ada');
  });

  it('the compiled body is not failed closed by the strict renderer', () => {
    const { body } = compileEmailContent(
      parse([
        { type: 'paragraph', text: 'Course {{event.course}}' },
        { type: 'button', label: 'Open', url: 'https://x.test/a?b=1&c=2' },
        { type: 'image', src: 'https://x.test/i.png', alt: 'Logo', width: 200 },
        { type: 'divider' },
      ])
    );
    const html = renderTemplate(body, vars({ course: 'Maths <b>' }), {
      mode: 'html',
    });
    expect(html).toContain('Course Maths &lt;b&gt;');
    expect(html).toContain('href="https://x.test/a?b=1&amp;c=2"');
  });

  it('an http image, an image src with {{, 11 images and width 601 are rejected', () => {
    const image = (over: Record<string, unknown>) => ({
      type: 'image',
      src: 'https://x.test/i.png',
      alt: 'a',
      ...over,
    });
    for (const bad of [
      image({ src: 'http://x.test/i.png' }),
      image({ src: 'https://x.test/{{profile.name}}.png' }),
      image({ src: 'https://user:pw@x.test/i.png' }),
      image({ src: 'javascript:alert(1)' }),
      image({ width: 601 }),
    ]) {
      expect(zEmailContent.safeParse(content([bad])).success).toBe(false);
    }
    const eleven = Array.from({ length: 11 }, () => image({}));
    expect(zEmailContent.safeParse(content(eleven)).success).toBe(false);
    expect(zEmailContent.safeParse(content(eleven.slice(1))).success).toBe(
      true
    );
  });

  it('the text alternative lists the button label and url', () => {
    const { text } = compileEmailContent(
      parse([
        { type: 'heading', text: 'Title' },
        { type: 'button', label: 'Open', url: 'https://x.test/a' },
        { type: 'image', src: 'https://x.test/i.png', alt: 'Logo' },
        { type: 'divider' },
      ])
    );
    expect(text).toBe('Title\n\nOpen: https://x.test/a\n\n[Logo]\n\n---');
  });

  it('is deterministic and rejects an email too large to pin', () => {
    const blocks = [{ type: 'paragraph', text: 'x' }];
    expect(compileEmailContent(parse(blocks))).toEqual(
      compileEmailContent(parse(blocks))
    );
    const huge = Array.from({ length: 50 }, () => ({
      type: 'paragraph',
      text: 'x'.repeat(5000),
    }));
    expect(zEmailContent.safeParse(content(huge)).success).toBe(false);
  });
});
