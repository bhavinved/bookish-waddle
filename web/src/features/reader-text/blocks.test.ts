import { describe, expect, it } from 'vitest';
import { blockIndexForOffset, toBlocks } from './blocks';

describe('toBlocks', () => {
  it('keeps source offsets for plain text paragraphs', () => {
    const text = 'one\n\ntwo\n\nthree';
    const blocks = toBlocks(text, 'txt');
    expect(blocks.map((b) => text.slice(b.offset).startsWith(b.html.replace(/<\/?p>/g, '')))).toEqual([true, true, true]);
    expect(blockIndexForOffset(blocks, text.indexOf('two') + 1)).toBe(1);
  });

  it('sanitizes markdown', () => {
    const [b] = toBlocks('<script>alert(1)</script>\n\n# Hi', 'md');
    expect(b?.html ?? '').not.toContain('<script');
  });
});
