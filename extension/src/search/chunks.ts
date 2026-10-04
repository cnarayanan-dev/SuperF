// Chunking: groups the sentences of a page into chunks. Pure functions on plain spans,
// shared by the extension and the benchmark.
import type { Span } from './sentences.ts';

// One sentence of a chunk, with offsets in the text of its paragraph.
export interface SentenceSpan { paragraph: number; start: number; end: number }

// Overlap is always smaller than the chunk length.
export function clampOverlap(length: number, overlap: number): number {
  return Math.max(0, Math.min(overlap, length - 1));
}

// paragraphs[i] holds the sentence spans of paragraph i. Chunks advance by length minus overlap.
// The last chunk of a sequence may be shorter. With cross off, each paragraph is its own sequence,
// so a chunk never leaves its paragraph. With cross on, all sentences of the page form one
// sequence and a chunk can cover several paragraphs.
export function chunkSentences(paragraphs: Span[][], length: number, overlap: number, cross = false): SentenceSpan[][] {
  length = Math.max(1, Math.floor(length));
  const step = length - clampOverlap(length, Math.floor(overlap));
  const spans = paragraphs.map((sentences, paragraph) => sentences.map(([start, end]): SentenceSpan => ({ paragraph, start, end })));
  const chunks: SentenceSpan[][] = [];
  for (const sequence of cross ? [spans.flat()] : spans) {
    for (let i = 0; i < sequence.length; i += step) {
      chunks.push(sequence.slice(i, i + length));
      // A further chunk would only repeat sentences of this one.
      if (i + length >= sequence.length) break;
    }
  }
  return chunks;
}

// The run of `length` consecutive sentences with the highest summed score, as [start, end).
// The first such run wins a tie. This picks the highlight inside a chunk that is longer than it.
export function bestWindow(scores: number[], length: number): [start: number, end: number] {
  if (length >= scores.length) return [0, scores.length];
  let best = 0, bestSum = -Infinity;
  for (let i = 0; i + length <= scores.length; i++) {
    let sum = 0;
    for (let k = i; k < i + length; k++) sum += scores[k];
    if (sum > bestSum) { bestSum = sum; best = i; }
  }
  return [best, best + length];
}

// One range per paragraph the sentences touch, for highlighting a chunk or a part of it.
export function chunkRanges(chunk: SentenceSpan[]): [paragraph: number, start: number, end: number][] {
  const out: [number, number, number][] = [];
  for (const s of chunk) {
    const last = out.at(-1);
    if (last?.[0] === s.paragraph) last[2] = s.end;
    else out.push([s.paragraph, s.start, s.end]);
  }
  return out;
}
