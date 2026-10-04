// Chunking. Pure functions on sentence spans, shared by the extension and the benchmark.
import type { Span } from './sentences.ts';

// One sentence of a chunk. The offsets point into the text of its paragraph.
export interface SentenceSpan { para: number; start: number; end: number }

// Overlap is always smaller than chunk length.
export function clampOverlap(chunkLength: number, overlap: number): number {
  return Math.max(0, Math.min(overlap, chunkLength - 1));
}

// paragraphs[p] holds the sentence spans of paragraph p. Chunks advance by chunk length minus
// overlap. The last chunk of a sequence may be shorter. With cross off, each paragraph is its own
// sequence, so a chunk never leaves its paragraph. With cross on, all sentences of the page form
// one sequence and a chunk can cover several paragraphs.
export function chunkSentences(paragraphs: Span[][], chunkLength: number, overlap: number, cross = false): SentenceSpan[][] {
  const step = chunkLength - clampOverlap(chunkLength, overlap);
  const spans = paragraphs.map((sentences, para) => sentences.map(([start, end]): SentenceSpan => ({ para, start, end })));
  const out: SentenceSpan[][] = [];
  for (const seq of cross ? [spans.flat()] : spans) {
    for (let i = 0; i < seq.length; i += step) {
      out.push(seq.slice(i, i + chunkLength));
      // This chunk reached the end. A further one would only repeat its sentences.
      if (i + chunkLength >= seq.length) break;
    }
  }
  return out;
}

// The text given to the model: the sentences joined with a space.
export function chunkText(paragraphTexts: string[], sentences: SentenceSpan[]): string {
  return sentences.map((s) => paragraphTexts[s.para].slice(s.start, s.end)).join(' ');
}

// The run of `length` consecutive sentences with the highest summed score, as [start, end).
// The first such run wins a tie.
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

// One range per paragraph the sentences touch, for highlighting.
export function toRanges(sentences: SentenceSpan[]): SentenceSpan[] {
  const out: SentenceSpan[] = [];
  for (const s of sentences) {
    const prev = out[out.length - 1];
    if (prev?.para === s.para) prev.end = s.end;
    else out.push({ ...s });
  }
  return out;
}
