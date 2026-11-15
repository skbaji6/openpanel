import { describe, expect, it } from 'vitest';
import {
  addBlock,
  type EmailBlock,
  emailProblems,
  moveBlock,
  removeBlock,
} from './email-blocks';

const heading = (text: string): EmailBlock => ({ type: 'heading', text });
const texts = (blocks: EmailBlock[]) =>
  blocks.map((b) => ('text' in b ? b.text : b.type));
const image = (over: Record<string, unknown>) =>
  ({
    type: 'image',
    src: 'https://x.test/i.png',
    alt: 'a',
    ...over,
  }) as EmailBlock;
const problems = (blocks: EmailBlock[], subject = 'Hi') =>
  emailProblems({ subject, blocks });

describe('email blocks', () => {
  it('move and remove keep the other blocks in order', () => {
    const blocks = [heading('a'), heading('b'), heading('c'), heading('d')];
    expect(texts(moveBlock(blocks, 0, 2))).toEqual(['b', 'c', 'a', 'd']);
    expect(texts(moveBlock(blocks, 3, 0))).toEqual(['d', 'a', 'b', 'c']);
    expect(moveBlock(blocks, 1, 9)).toEqual(blocks);
    expect(texts(removeBlock(blocks, 1))).toEqual(['a', 'c', 'd']);
    expect(texts(addBlock(blocks, 'divider', 1))).toEqual([
      'a',
      'divider',
      'b',
      'c',
      'd',
    ]);
  });

  it('problems match the backend limits', () => {
    expect(problems([heading('ok')])).toEqual([]);
    expect(problems([])).toHaveLength(1);
    expect(problems([heading('ok')], '')).toHaveLength(1);
    expect(problems([heading('x'.repeat(201))])[0]?.index).toBe(0);
    expect(problems([image({ src: 'http://x.test/i.png' })])).toHaveLength(1);
    expect(problems([image({ src: 'https://x.test/{{a}}.png' })])).toHaveLength(
      1
    );
    expect(problems([image({ src: 'https://u:p@x.test/i.png' })])).toHaveLength(
      1
    );
    expect(problems([image({ alt: '' })])).toHaveLength(1);
    expect(problems([image({ width: 601 })])).toHaveLength(1);
    expect(problems([image({ width: 600 })])).toEqual([]);
    expect(
      problems(Array.from({ length: 11 }, () => image({})))[0]?.index
    ).toBeNull();
    expect(
      problems(Array.from({ length: 51 }, () => heading('x')))[0]?.index
    ).toBeNull();
    expect(
      problems([{ type: 'button', label: 'Go', url: 'https://x.test' }])
    ).toEqual([]);
  });
});
