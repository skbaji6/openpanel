// Mirrors packages/marketing/src/templates/email-blocks.ts; keep the limits in step.
export const MAX_EMAIL_BLOCKS = 50;
export const MAX_EMAIL_IMAGES = 10;
export const MAX_EMAIL_IMAGE_WIDTH = 600;
export const MIN_EMAIL_IMAGE_WIDTH = 16;
export const MAX_EMAIL_SUBJECT_LENGTH = 300;
export const MAX_HEADING_LENGTH = 200;
export const MAX_PARAGRAPH_LENGTH = 5000;
export const MAX_LABEL_LENGTH = 80;
export const MAX_ALT_LENGTH = 200;
export const MAX_URL_LENGTH = 2000;
export const MAX_COMPILED_LENGTH = 20_000;
// Markup the backend compiler wraps around each block and the whole email (measured from it).
const FRAME_OVERHEAD = 240;
const BLOCK_OVERHEAD: Record<EmailBlockType, number> = {
  heading: 145,
  paragraph: 128,
  button: 247,
  image: 122,
  divider: 125,
};
const IMAGE_WIDTH_OVERHEAD = 12;
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const UNSAFE_URL_CHARACTERS = /[\s\p{Cc}]/u;
const URL_MESSAGE =
  'Use a full https:// address, without {{placeholders}} or a user name and password';

export type EmailBlock =
  | { type: 'heading'; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'button'; label: string; url: string }
  | { type: 'image'; src: string; alt: string; width?: number }
  | { type: 'divider' };
export type EmailBlockType = EmailBlock['type'];

export interface EmailContent {
  subject: string;
  blocks: EmailBlock[];
}

export interface EmailProblem {
  // null when the problem is about the whole email, not one block.
  index: number | null;
  message: string;
}

export const EMAIL_BLOCK_TYPES: EmailBlockType[] = [
  'heading',
  'paragraph',
  'button',
  'image',
  'divider',
];

const BLANK_BLOCKS: Record<EmailBlockType, EmailBlock> = {
  heading: { type: 'heading', text: '' },
  paragraph: { type: 'paragraph', text: '' },
  button: { type: 'button', label: '', url: '' },
  image: { type: 'image', src: '', alt: '' },
  divider: { type: 'divider' },
};

export const emptyEmailContent = (): EmailContent => ({
  subject: '',
  blocks: [{ ...BLANK_BLOCKS.paragraph }],
});

export const removeBlock = (blocks: EmailBlock[], index: number) =>
  blocks.filter((_, i) => i !== index);

export function addBlock(
  blocks: EmailBlock[],
  type: EmailBlockType,
  index: number
): EmailBlock[] {
  const at = Math.max(0, Math.min(index, blocks.length));
  return [
    ...blocks.slice(0, at),
    { ...BLANK_BLOCKS[type] },
    ...blocks.slice(at),
  ];
}

export function moveBlock(
  blocks: EmailBlock[],
  from: number,
  to: number
): EmailBlock[] {
  const moved = blocks[from];
  if (!moved || to < 0 || to >= blocks.length || from === to) {
    return blocks;
  }
  const rest = removeBlock(blocks, from);
  return [...rest.slice(0, to), moved, ...rest.slice(to)];
}

function isSafeHttpsUrl(value: string): boolean {
  if (
    value.length > MAX_URL_LENGTH ||
    value.includes('{{') ||
    UNSAFE_URL_CHARACTERS.test(value)
  ) {
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

function imageProblem(block: Extract<EmailBlock, { type: 'image' }>) {
  if (!isSafeHttpsUrl(block.src)) {
    return URL_MESSAGE;
  }
  if (block.alt.trim().length === 0 || block.alt.length > MAX_ALT_LENGTH) {
    return `Describe the image in 1 to ${MAX_ALT_LENGTH} characters`;
  }
  const { width } = block;
  const validWidth =
    width === undefined ||
    (Number.isInteger(width) &&
      width >= MIN_EMAIL_IMAGE_WIDTH &&
      width <= MAX_EMAIL_IMAGE_WIDTH);
  return validWidth
    ? null
    : `Width is a whole number from ${MIN_EMAIL_IMAGE_WIDTH} to ${MAX_EMAIL_IMAGE_WIDTH}`;
}

function blockProblem(block: EmailBlock): string | null {
  switch (block.type) {
    case 'heading':
      return block.text.length > MAX_HEADING_LENGTH
        ? `Heading is at most ${MAX_HEADING_LENGTH} characters`
        : null;
    case 'paragraph':
      return block.text.length > MAX_PARAGRAPH_LENGTH
        ? `Paragraph is at most ${MAX_PARAGRAPH_LENGTH} characters`
        : null;
    case 'button':
      if (block.label.length > MAX_LABEL_LENGTH) {
        return `Button label is at most ${MAX_LABEL_LENGTH} characters`;
      }
      return isSafeHttpsUrl(block.url) ? null : URL_MESSAGE;
    case 'image':
      return imageProblem(block);
    default:
      return null;
  }
}

const escaped = (value: string) =>
  value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);

function blockLengths(block: EmailBlock): { html: number; text: number } {
  const html = BLOCK_OVERHEAD[block.type];
  switch (block.type) {
    case 'heading':
      return {
        html: html + escaped(block.text).length,
        text: block.text.length,
      };
    case 'paragraph':
      return {
        html: html + escaped(block.text).replace(/\r?\n/g, '<br>').length,
        text: block.text.length,
      };
    case 'button':
      return {
        html: html + escaped(block.url).length + escaped(block.label).length,
        text: block.label.length + 2 + block.url.length,
      };
    case 'image':
      return {
        html:
          html +
          escaped(block.src).length +
          escaped(block.alt).length +
          (block.width === undefined ? 0 : IMAGE_WIDTH_OVERHEAD),
        text: block.alt.length + 2,
      };
    default:
      return { html, text: 3 };
  }
}

// The server refuses an email whose compiled body or text passes 20,000 characters.
export function isEmailTooLarge(blocks: EmailBlock[]): boolean {
  let html = FRAME_OVERHEAD;
  let text = Math.max(0, blocks.length - 1) * 2;
  for (const block of blocks) {
    const lengths = blockLengths(block);
    html += lengths.html;
    text += lengths.text;
  }
  return html > MAX_COMPILED_LENGTH || text > MAX_COMPILED_LENGTH;
}

export function emailProblems(content: EmailContent): EmailProblem[] {
  const problems: EmailProblem[] = [];
  const subjectLength = content.subject.trim().length;
  if (
    subjectLength === 0 ||
    content.subject.length > MAX_EMAIL_SUBJECT_LENGTH
  ) {
    problems.push({
      index: null,
      message: `Subject is required, at most ${MAX_EMAIL_SUBJECT_LENGTH} characters`,
    });
  }
  if (content.blocks.length === 0 || content.blocks.length > MAX_EMAIL_BLOCKS) {
    problems.push({
      index: null,
      message: `Use 1 to ${MAX_EMAIL_BLOCKS} blocks`,
    });
  }
  const images = content.blocks.filter((b) => b.type === 'image').length;
  if (images > MAX_EMAIL_IMAGES) {
    problems.push({
      index: null,
      message: `At most ${MAX_EMAIL_IMAGES} images`,
    });
  }
  if (isEmailTooLarge(content.blocks)) {
    problems.push({
      index: null,
      message: `The email is too large. Shorten the text or remove blocks (limit ${MAX_COMPILED_LENGTH} characters once formatted)`,
    });
  }
  for (const [index, block] of content.blocks.entries()) {
    const message = blockProblem(block);
    if (message) {
      problems.push({ index, message });
    }
  }
  return problems;
}
