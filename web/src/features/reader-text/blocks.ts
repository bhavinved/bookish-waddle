import { marked } from 'marked';
import DOMPurify from 'dompurify';

export interface Block {
  /** Character offset of this block in the source text. */
  offset: number;
  html: string;
}

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Splits text into renderable blocks that remember their source offset, so a scroll position can be stored as a
 * text Locator. Markdown blocks are top-level marked tokens; plain text blocks are paragraphs.
 */
export function toBlocks(text: string, format: 'txt' | 'md'): Block[] {
  const blocks: Block[] = [];
  let offset = 0;
  if (format === 'md') {
    for (const token of marked.lexer(text)) {
      if (token.type !== 'space') {
        blocks.push({ offset, html: DOMPurify.sanitize(marked.parser([token])) });
      }
      offset += token.raw.length;
    }
  } else {
    for (const part of text.split(/(?<=\n[ \t]*\r?\n)/)) {
      if (part.trim()) blocks.push({ offset, html: `<p>${escapeHtml(part.trim())}</p>` });
      offset += part.length;
    }
  }
  return blocks;
}

/** Index of the last block whose offset is <= `offset`. */
export function blockIndexForOffset(blocks: Pick<Block, 'offset'>[], offset: number): number {
  let idx = 0;
  for (let i = 0; i < blocks.length; i++) {
    if ((blocks[i]?.offset ?? 0) <= offset) idx = i;
    else break;
  }
  return idx;
}
