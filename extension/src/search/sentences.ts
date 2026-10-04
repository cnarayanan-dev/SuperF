// Sentence splitting and grouping into chunks. Pure functions on plain text.

export type Span = [start: number, end: number];

const ABBREV = /(?:^|[\s(])(?:[A-Za-z]|Mr|Mrs|Ms|Dr|Prof|St|vs|etc|e\.g|i\.e|No|Fig|approx)$/;
const BOUNDARY = /[.!?]+["'”’)\]]*\s+(?=["'“‘(\[]?[A-Z0-9])|\n\s*\n/g;
const MAX_SENTENCE_CHARS = 400;

function pushTrimmed(text: string, start: number, end: number, out: Span[]): void {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  if (end <= start) return;
  // Text without sentence punctuation (tables, code) is cut at whitespace so chunks stay small.
  while (end - start > MAX_SENTENCE_CHARS) {
    let cut = text.lastIndexOf(' ', start + MAX_SENTENCE_CHARS);
    if (cut <= start) cut = start + MAX_SENTENCE_CHARS;
    out.push([start, cut]);
    start = cut;
    while (start < end && /\s/.test(text[start])) start++;
  }
  if (end > start) out.push([start, end]);
}

export function splitSentences(text: string): Span[] {
  const out: Span[] = [];
  let start = 0;
  for (const m of text.matchAll(BOUNDARY)) {
    const dotAt = m.index;
    if (m[0][0] === '.' && ABBREV.test(text.slice(Math.max(0, dotAt - 8), dotAt))) continue;
    pushTrimmed(text, start, m.index + m[0].length, out);
    start = m.index + m[0].length;
  }
  pushTrimmed(text, start, text.length, out);
  return out;
}

// Groups of `max` sentences. A trailing group shorter than `min` joins the group before it.
export function groupSentences(sentences: Span[], min: number, max: number): Span[] {
  const out: Span[] = [];
  for (let i = 0; i < sentences.length; i += max) {
    const group = sentences.slice(i, i + max);
    if (group.length < min && out.length) out[out.length - 1][1] = group[group.length - 1][1];
    else out.push([group[0][0], group[group.length - 1][1]]);
  }
  return out;
}
