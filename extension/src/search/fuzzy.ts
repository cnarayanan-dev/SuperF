// Fuzzy word matching. Pure functions, shared by the extension and the benchmark.

export interface Token {
  t: string; // normalized form
  start: number; // offsets in the original text
  end: number;
}

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    out.push({ t: normalize(m[0]), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

// Optimal string alignment distance (Damerau-Levenshtein with adjacent swaps).
export function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array<number>(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    const c = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[m][n];
}

// Similarity of one query word to one page word, 0 to 1.
export function tokSim(q: string, t: string): number {
  if (q === t) return 1;
  if (q.length >= 4 && (t.startsWith(q) || (q.startsWith(t) && t.length >= 4))) return 0.9;
  if (q.length >= 4 && t.includes(q)) return 0.8;
  const s = 1 - editDistance(q, t) / Math.max(q.length, t.length);
  return s >= 0.6 && Math.min(q.length, t.length) >= 4 ? s : 0;
}

export interface FuzzyMatch {
  score: number; // length-weighted mean of the best match per query word
  hits: number[]; // index of the best chunk token for each query word that matched
}

// caches[i] memoizes tokSim for query word i, so repeated page words cost one lookup.
export function fuzzyMatch(qTokens: string[], cTokens: Token[], caches?: Map<string, number>[]): FuzzyMatch {
  let sum = 0, total = 0;
  const hits: number[] = [];
  qTokens.forEach((q, i) => {
    const cache = caches?.[i];
    let best = 0, bestAt = -1;
    for (let k = 0; k < cTokens.length; k++) {
      const t = cTokens[k].t;
      let s = cache?.get(t);
      if (s === undefined) { s = tokSim(q, t); cache?.set(t, s); }
      if (s > best) { best = s; bestAt = k; }
    }
    if (bestAt >= 0) hits.push(bestAt);
    sum += best * q.length;
    total += q.length;
  });
  return { score: total ? sum / total : 0, hits };
}

export function fuzzyScores(query: string, chunks: string[]): number[] {
  const qt = tokenize(query).map((t) => t.t);
  const caches = qt.map(() => new Map<string, number>());
  return chunks.map((c) => fuzzyMatch(qt, tokenize(c), caches).score);
}
