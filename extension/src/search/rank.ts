// Cosine ranking and the hybrid merge. Pure functions, shared by the extension and the benchmark.

// Vectors are normalized, so the dot product equals cosine similarity.
export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function minMax(a: number[]): number[] {
  let lo = Infinity, hi = -Infinity;
  for (const x of a) { if (x < lo) lo = x; if (x > hi) hi = x; }
  return a.map((x) => (hi > lo ? (x - lo) / (hi - lo) : 0));
}

// weight is the semantic share, the rest goes to fuzzy. Both inputs are min-max scaled per page.
export function hybridScores(semantic: number[], fuzzy: number[], weight: number): number[] {
  const s = minMax(semantic), f = minMax(fuzzy);
  return s.map((x, i) => weight * x + (1 - weight) * f[i]);
}

// Ties count against the gold chunk, so an all-zero score is a miss and not a free rank 1.
export function rankOf(scores: number[], gold: number): number {
  let r = 1;
  for (let i = 0; i < scores.length; i++) if (i !== gold && scores[i] >= scores[gold]) r++;
  return r;
}
