// DOM text extraction. Each chunk remembers where its text sits in the page,
// so a result can be turned back into a Range for highlighting.
import { tokenize, type Token } from '../search/fuzzy.ts';
import { chunkSentences, type SentenceSpan } from '../search/chunks.ts';
import { splitSentences } from '../search/sentences.ts';

export interface Block {
  text: string;
  segs: { node: Text; start: number }[]; // text nodes in order, with their offset in `text`
}

export interface Chunk {
  spans: SentenceSpan[]; // the sentences of the chunk, a paragraph is a block
  text: string; // what the model sees: the sentences joined with a space
  tokens: Token[];
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'SELECT', 'IFRAME', 'SVG', 'CANVAS', 'TEMPLATE']);

export function extractBlocks(root: Element, ignore: Element): Block[] {
  const blockOf = new Map<Element, Element>();
  const visible = new Map<Element, boolean>();

  const isVisible = (el: Element): boolean => {
    let v = visible.get(el);
    if (v === undefined) {
      v = el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true } as CheckVisibilityOptions);
      visible.set(el, v);
    }
    return v;
  };
  const blockAncestor = (el: Element): Element => {
    let b = blockOf.get(el);
    if (!b) {
      b = el;
      while (b.parentElement && /^(inline|contents)/.test(getComputedStyle(b).display)) b = b.parentElement;
      blockOf.set(el, b);
    }
    return b;
  };

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      const el = n as Element;
      return el === ignore || SKIP.has(el.tagName.toUpperCase()) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
    },
  });

  const blocks: Block[] = [];
  let current: Block | null = null;
  let currentAncestor: Element | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    const parent = node.parentElement;
    if (!parent || !node.data) continue;
    const blank = !/\S/.test(node.data);
    if (blank && !current) continue;
    if (!isVisible(parent)) continue;
    const ancestor = blockAncestor(parent);
    if (ancestor !== currentAncestor) {
      if (blank) continue;
      current = { text: '', segs: [] };
      currentAncestor = ancestor;
      blocks.push(current);
    }
    current!.segs.push({ node, start: current!.text.length });
    current!.text += node.data;
  }
  return blocks;
}

export function buildChunks(blocks: Block[], chunkLength: number, overlap: number): Chunk[] {
  return chunkSentences(blocks.map((b) => splitSentences(b.text)), chunkLength, overlap).map((spans) => {
    const text = spans.map((s) => blocks[s.paragraph].text.slice(s.start, s.end)).join(' ');
    return { spans, text, tokens: tokenize(text) };
  });
}

export function toRange(block: Block, start: number, end: number): Range {
  const segs = block.segs;
  let a = 0, b = 0;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].start <= start) a = i;
    if (segs[i].start < end) b = i;
  }
  const range = document.createRange();
  range.setStart(segs[a].node, Math.min(start - segs[a].start, segs[a].node.length));
  range.setEnd(segs[b].node, Math.min(end - segs[b].start, segs[b].node.length));
  return range;
}
