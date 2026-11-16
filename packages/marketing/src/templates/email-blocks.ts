import { z } from 'zod';
import { MAX_BODY_LENGTH } from '../rules/rule.schema';

export const MAX_EMAIL_BLOCKS = 50;
export const MAX_EMAIL_IMAGES = 10;
export const MAX_EMAIL_IMAGE_WIDTH = 600;
const MIN_EMAIL_IMAGE_WIDTH = 16;
const MAX_SUBJECT_LENGTH = 300;
const MAX_HEADING_LENGTH = 200;
const MAX_PARAGRAPH_LENGTH = 5000;
const MAX_LABEL_LENGTH = 80;
const MAX_ALT_LENGTH = 200;
const MAX_URL_LENGTH = 2000;
const UNSAFE_URL_CHARACTERS = /[\s\p{Cc}]/u;
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function isSafeHttpsUrl(value: string): boolean {
  if (value.includes('{{') || UNSAFE_URL_CHARACTERS.test(value)) {
    return false;
  }
  const url = URL.parse(value);
  return (
    url !== null &&
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === ''
  );
}

const zHttpsUrl = z.string().max(MAX_URL_LENGTH).refine(isSafeHttpsUrl, {
  message: 'must be an https url without credentials',
});

export const zEmailBlock = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('heading'),
    text: z.string().max(MAX_HEADING_LENGTH),
  }),
  z.strictObject({
    type: z.literal('paragraph'),
    text: z.string().max(MAX_PARAGRAPH_LENGTH),
  }),
  z.strictObject({
    type: z.literal('button'),
    label: z.string().max(MAX_LABEL_LENGTH),
    url: zHttpsUrl,
  }),
  z.strictObject({
    type: z.literal('image'),
    src: zHttpsUrl,
    alt: z.string().min(1).max(MAX_ALT_LENGTH),
    width: z
      .number()
      .int()
      .min(MIN_EMAIL_IMAGE_WIDTH)
      .max(MAX_EMAIL_IMAGE_WIDTH)
      .optional(),
  }),
  z.strictObject({ type: z.literal('divider') }),
]);
export type EmailBlock = z.infer<typeof zEmailBlock>;

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);

const FONT = 'font-family:Arial,Helvetica,sans-serif;color:#222222;';
const CELL = 'padding:8px 24px;';
const LINE_BREAK = /\r?\n/g;

function blockHtml(block: EmailBlock): string {
  switch (block.type) {
    case 'heading':
      return `<td style="${CELL}${FONT}font-size:24px;font-weight:bold;line-height:1.3;">${escapeHtml(block.text)}</td>`;
    case 'paragraph':
      return `<td style="${CELL}${FONT}font-size:16px;line-height:1.5;">${escapeHtml(block.text).replace(LINE_BREAK, '<br>')}</td>`;
    case 'button':
      return `<td style="${CELL}"><a href="${escapeHtml(block.url)}" style="${FONT}display:inline-block;padding:12px 24px;background:#0b5fff;color:#ffffff;font-size:16px;text-decoration:none;border-radius:4px;">${escapeHtml(block.label)}</a></td>`;
    case 'image': {
      const width = block.width === undefined ? '' : ` width="${block.width}"`;
      return `<td style="${CELL}"><img src="${escapeHtml(block.src)}" alt="${escapeHtml(block.alt)}"${width} style="display:block;max-width:100%;height:auto;border:0;"></td>`;
    }
    case 'divider':
      return `<td style="${CELL}"><div style="border-top:1px solid #dddddd;font-size:0;line-height:0;">&nbsp;</div></td>`;
    default:
      return block satisfies never;
  }
}

function blockText(block: EmailBlock): string {
  switch (block.type) {
    case 'heading':
    case 'paragraph':
      return block.text;
    case 'button':
      return `${block.label}: ${block.url}`;
    case 'image':
      return `[${block.alt}]`;
    case 'divider':
      return '---';
    default:
      return block satisfies never;
  }
}

// Both outputs are templates for renderTemplate: literal text is escaped here, placeholders stay verbatim.
export function compileEmailContent(content: {
  subject: string;
  blocks: EmailBlock[];
}): { subject: string; body: string; text: string } {
  const rows = content.blocks.map((block) => `<tr>${blockHtml(block)}</tr>`);
  const frame =
    'role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"';
  return {
    subject: content.subject,
    body: `<table ${frame}><tr><td align="center"><table ${frame} style="max-width:600px;">${rows.join('')}</table></td></tr></table>`,
    text: content.blocks.map(blockText).join('\n\n'),
  };
}

export const zEmailContent = z
  .strictObject({
    subject: z.string().min(1).max(MAX_SUBJECT_LENGTH),
    blocks: z.array(zEmailBlock).min(1).max(MAX_EMAIL_BLOCKS),
  })
  .superRefine((content, ctx) => {
    const images = content.blocks.filter((b) => b.type === 'image').length;
    if (images > MAX_EMAIL_IMAGES) {
      ctx.addIssue({
        code: 'custom',
        path: ['blocks'],
        message: `at most ${MAX_EMAIL_IMAGES} images`,
      });
      return;
    }
    // A pinned journey step stores the compiled email, whose fields are capped at MAX_BODY_LENGTH.
    const { body, text } = compileEmailContent(content);
    if (body.length > MAX_BODY_LENGTH || text.length > MAX_BODY_LENGTH) {
      ctx.addIssue({
        code: 'custom',
        path: ['blocks'],
        message: 'the email is too large',
      });
    }
  });
export type EmailContent = z.infer<typeof zEmailContent>;
