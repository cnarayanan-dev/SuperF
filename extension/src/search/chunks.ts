// Chunking: groups the sentences of a page into chunks. Pure functions on plain spans,
// shared by the extension and the benchmark.
import type { Span } from './sentences.ts';

// One sentence of a chunk, with offsets in the text of its paragraph.
export interface SentenceSpan { paragraph: number; start: number; end: number }

// Overlap is always smaller than the chunk length.
export function clampOverlap(length: number, overlap: number): number {
  return Math.max(0, Math.min(overlap, length - 1));
}

// paragraphs[i] holds the sentence spans of paragraph i. Chunks advance by length minus overlap
// and never leave their paragraph. The last chunk of a paragraph may be shorter.
export function chunkSentences(paragraphs: Span[][], length: number, overlap: number): SentenceSpan[][] {
  const step = length - clampOverlap(length, overlap);
  const chunks: SentenceSpan[][] = [];
  paragraphs.forEach((sentences, paragraph) => {
    for (let i = 0; i < sentences.length; i += step) {
      chunks.push(sentences.slice(i, i + length).map(([start, end]) => ({ paragraph, start, end })));
      // A further chunk would only repeat sentences of this one.
      if (i + length >= sentences.length) break;
    }
  });
  return chunks;
}

// One range per paragraph the chunk touches, for highlighting the whole chunk.
export function chunkRanges(chunk: SentenceSpan[]): [paragraph: number, start: number, end: number][] {
  const out: [number, number, number][] = [];
  for (const s of chunk) {
    const last = out[out.length - 1];
    if (last?.[0] === s.paragraph) last[2] = s.end;
    else out.push([s.paragraph, s.start, s.end]);
  }
  return out;
}
