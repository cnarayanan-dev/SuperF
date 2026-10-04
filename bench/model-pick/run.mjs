// Quick model-pick benchmark. Node/CPU only, not browser WebGPU/WASM numbers.
import { readFileSync, writeFileSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const { pages, queries } = JSON.parse(readFileSync('cases.json', 'utf8'));
const CATS = ['exact', 'typo', 'variant', 'synonym', 'paraphrase'];
const HYBRID_W = 0.7;

const MODELS = [
  { id: 'Xenova/all-MiniLM-L6-v2', pooling: 'mean', qp: '', dp: '' },
  { id: 'Xenova/bge-small-en-v1.5', pooling: 'cls', qp: 'Represent this sentence for searching relevant passages: ', dp: '' },
  { id: 'Xenova/gte-small', pooling: 'mean', qp: '', dp: '' },
];

// ---------- fuzzy ----------
const norm = s => s.toLowerCase().replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
  .normalize('NFD').replace(/[̀-ͯ]/g, '');
const toks = s => norm(s).split(/[^a-z0-9]+/).filter(Boolean);
function dl(a, b) { // optimal string alignment (Damerau-Levenshtein)
  const m = a.length, n = b.length; const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    const c = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[m][n];
}
function tokSim(q, t) {
  if (q === t) return 1;
  if (q.length >= 4 && (t.startsWith(q) || q.startsWith(t) && t.length >= 4)) return 0.9;
  if (q.length >= 4 && t.includes(q)) return 0.8;
  const s = 1 - dl(q, t) / Math.max(q.length, t.length);
  return s >= 0.6 && Math.min(q.length, t.length) >= 4 ? s : 0;
}
function fuzzyScores(query, chunks) {
  const qt = toks(query); const w = qt.map(t => t.length);
  return chunks.map(c => {
    const ct = toks(c); let sum = 0;
    qt.forEach((q, i) => { let best = 0; for (const t of ct) best = Math.max(best, tokSim(q, t)); sum += best * w[i]; });
    return sum / w.reduce((a, b) => a + b, 0);
  });
}
const mm = a => { const lo = Math.min(...a), hi = Math.max(...a); return a.map(x => hi > lo ? (x - lo) / (hi - lo) : 0); };

// ---------- metrics ----------
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
function rankOf(scores, gold) { let r = 1; for (let i = 0; i < scores.length; i++) if (i !== gold && scores[i] > scores[gold]) r++; return r; }
function summarize(ranks) { // ranks: [{category, cross, rank}]
  const f = rs => rs.length ? { n: rs.length, r1: mean(rs.map(r => +(r.rank === 1))), r5: mean(rs.map(r => +(r.rank <= 5))), mrr: mean(rs.map(r => 1 / r.rank)) } : null;
  const out = { overall: f(ranks), crossLanguage: f(ranks.filter(r => r.cross)) };
  for (const c of CATS) out[c] = f(ranks.filter(r => r.category === c));
  return out;
}
function dirSize(p) { if (!existsSync(p)) return 0; let t = 0; for (const e of readdirSync(p, { withFileTypes: true })) { const f = join(p, e.name); t += e.isDirectory() ? dirSize(f) : statSync(f).size; } return t; }

const results = { env: { node: process.version, note: 'Node CPU (onnxruntime-node), not browser WebGPU/WASM' }, cases: { pages: pages.length, queries: queries.length }, systems: {} };

// ---------- fuzzy baseline ----------
{
  const rk = [], lat = [];
  for (const q of queries) {
    const ch = pages.find(p => p.id === q.page).chunks;
    const t0 = performance.now(); const s = fuzzyScores(q.query, ch); lat.push(performance.now() - t0);
    rk.push({ category: q.category, cross: q.crossLanguage, rank: rankOf(s, q.chunk) });
  }
  results.systems['fuzzy-only'] = { status: 'ok', metrics: summarize(rk), queryMs: { mean: mean(lat), p95: pct(lat, 0.95) }, downloadMB: 0 };
}

// ---------- models ----------
let tf; try { tf = await import('@huggingface/transformers'); } catch (e) { tf = null; results.tfError = String(e); }
for (const m of MODELS) {
  const cacheDir = resolve('.cache', m.id.replace('/', '__'));
  const sys = results.systems[m.id] = { status: 'ok' };
  try {
    if (!tf) throw new Error('transformers import failed');
    tf.env.cacheDir = cacheDir; tf.env.allowLocalModels = false;
    rmSync(cacheDir, { recursive: true, force: true });
    const rss0 = process.memoryUsage().rss;
    let t0 = performance.now();
    let ex = await tf.pipeline('feature-extraction', m.id, { dtype: 'q8' });
    sys.loadColdMs = performance.now() - t0;
    sys.downloadMB = dirSize(cacheDir) / 1e6;
    ex = null; t0 = performance.now();
    ex = await tf.pipeline('feature-extraction', m.id, { dtype: 'q8' });
    sys.loadCachedMs = performance.now() - t0;
    sys.rssDeltaMB = (process.memoryUsage().rss - rss0) / 1e6;
    const embed = async (texts) => { const out = []; for (let i = 0; i < texts.length; i += 16) { const t = await ex(texts.slice(i, i + 16), { pooling: m.pooling, normalize: true }); out.push(...t.tolist()); } return out; };
    await embed(['warmup']);
    const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
    const pageVec = {}, idx = [];
    for (const p of pages) { const t = performance.now(); pageVec[p.id] = await embed(p.chunks.map(c => m.dp + c)); idx.push(performance.now() - t); }
    sys.indexMsPerPage = mean(idx); sys.indexMsPerChunk = idx.reduce((a, b) => a + b, 0) / pages.reduce((n, p) => n + p.chunks.length, 0);
    const sem = [], hyb = [], lat = [];
    for (const q of queries) {
      const p = pages.find(x => x.id === q.page);
      const t0 = performance.now(); const [qv] = await embed([m.qp + q.query]);
      const s = pageVec[q.page].map(v => dot(qv, v)); lat.push(performance.now() - t0);
      const f = fuzzyScores(q.query, p.chunks); const ns = mm(s), nf = mm(f);
      const h = ns.map((x, i) => HYBRID_W * x + (1 - HYBRID_W) * nf[i]);
      sem.push({ category: q.category, cross: q.crossLanguage, rank: rankOf(s, q.chunk) });
      hyb.push({ category: q.category, cross: q.crossLanguage, rank: rankOf(h, q.chunk) });
    }
    sys.metrics = summarize(sem); sys.queryMs = { mean: mean(lat), p95: pct(lat, 0.95) };
    results.systems[m.id + ' + fuzzy (0.7/0.3)'] = { status: 'ok', metrics: summarize(hyb), note: 'min-max normalized semantic 0.7 + fuzzy 0.3' };
  } catch (e) { sys.status = 'blocked'; sys.error = String(e.cause?.message || e.message || e).slice(0, 300); }
}

writeFileSync('results.json', JSON.stringify(results, null, 1));

// ---------- markdown ----------
const f2 = x => x == null ? 'n/a' : x.toFixed(2), f0 = x => x == null ? 'n/a' : x.toFixed(0);
let md = `# Model pick results (quick first pass)\n\nGenerated by \`run.mjs\`. ${results.cases.queries} queries over ${results.cases.pages} pages (see \`cases.json\`). Cells are Recall@1 / Recall@5 / MRR.\n\n`;
md += `Note: these are Node ${process.version} CPU numbers (onnxruntime-node). They are not browser WebGPU or WASM numbers, so absolute speeds will differ in Chrome. Accuracy should transfer, speed should not.\n\n`;
const cols = [...CATS, 'overall', 'crossLanguage'];
md += `## Accuracy\n\n| System | ${cols.join(' | ')} |\n|---|${cols.map(() => '---').join('|')}|\n`;
for (const [k, v] of Object.entries(results.systems)) {
  if (v.status !== 'ok') { md += `| ${k} | ${cols.map(() => 'blocked').join(' | ')} |\n`; continue; }
  md += `| ${k} | ${cols.map(c => { const x = v.metrics[c]; return x ? `${f2(x.r1)} / ${f2(x.r5)} / ${f2(x.mrr)}` : 'n/a'; }).join(' | ')} |\n`;
}
md += `\n## Speed and size\n\n| System | Download MB (q8) | Load cold ms | Load cached ms | Index ms/page | Index ms/chunk | Query mean ms | Query p95 ms | RSS delta MB |\n|---|---|---|---|---|---|---|---|---|\n`;
for (const [k, v] of Object.entries(results.systems)) {
  if (k.includes('+ fuzzy')) continue;
  if (v.status !== 'ok') { md += `| ${k} | blocked | | | | | | | |\n`; continue; }
  md += `| ${k} | ${f2(v.downloadMB)} | ${f0(v.loadColdMs)} | ${f0(v.loadCachedMs)} | ${f0(v.indexMsPerPage)} | ${f2(v.indexMsPerChunk)} | ${f2(v.queryMs.mean)} | ${f2(v.queryMs.p95)} | ${f0(v.rssDeltaMB)} |\n`;
}
const blocked = Object.entries(results.systems).filter(([, v]) => v.status !== 'ok');
if (blocked.length) md += `\n## Problems\n\n${blocked.map(([k, v]) => `- ${k}: ${v.error}`).join('\n')}\n`;
writeFileSync('results.md', md);
console.log(md);
