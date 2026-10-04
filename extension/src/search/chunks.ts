// Chunking. Pure functions on sentence spans, shared by the extension and the benchmark.
import type { Span } from './sentences.ts';

// One sentence of a chunk. The offsets point into the text of its paragraph.
export interface SentenceSpan { para: number; start: number; end: number }

// Overlap is always smaller than chunk length.
export function clampOverlap(chunkLength: number, overlap: number): number {
  return Math.max(0, Math.min(overlap, chunkLength - 1));
}

// paragraphs[p] holds the sentence spans of paragraph p. Chunks advance by chunk length minus
// overlap and never leave their paragraph. The last chunk of a paragraph may be shorter.
export function chunkSentences(paragraphs: Span[][], chunkLength: number, overlap: number): SentenceSpan[][] {
  const step = chunkLength - clampOverlap(chunkLength, overlap);
  const out: SentenceSpan[][] = [];
  paragraphs.forEach((sentences, para) => {
    const seq = sentences.map(([start, end]): SentenceSpan => ({ para, start, end }));
    for (let i = 0; i < seq.length; i += step) {
      out.push(seq.slice(i, i + chunkLength));
      // This chunk reached the end. A further one would only repeat its sentences.
      if (i + chunkLength >= seq.length) break;
    }
  });
  return out;
}

// The text given to the model: the sentences joined with a space.
export function chunkText(paragraphTexts: string[], sentences: SentenceSpan[]): string {
  return sentences.map((s) => paragraphTexts[s.para].slice(s.start, s.end)).join(' ');
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
