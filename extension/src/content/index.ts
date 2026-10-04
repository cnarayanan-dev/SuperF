// Content script: overlay UI, search orchestration and highlighting.
import { fuzzyMatch, tokenize } from '../search/fuzzy.ts';
import { hybridScores, isShown } from '../search/rank.ts';
import type { ErrorResponse, IndexResponse, QueryResponse, Request } from '../messages.ts';
import { MODEL } from '../model.ts';
import { buildChunks, extractBlocks, toRange, type Block, type Chunk } from './dom.ts';
import { OVERLAY_CSS, OVERLAY_HTML, PAGE_CSS } from './ui.ts';

interface Settings { threshold: number; minS: number; maxS: number; weight: number; dev: boolean }
interface Result {
  ranges: [block: number, start: number, end: number][];
  chunk: number;
  fuzzy: number;
  semantic: number;
  hybrid: number;
}

const DEFAULTS: Settings = { threshold: MODEL.defaultThreshold, minS: 1, maxS: 2, weight: 0.7, dev: false };
const DEBOUNCE_MS = 150;
const BATCH = 32;
const MAX_RESULTS = 10;

// Stored keys from earlier builds (like "mode") are ignored, missing ones fall back to the defaults.
function loadSettings(stored: Record<string, unknown> = {}): Settings {
  const out: Record<string, unknown> = { ...DEFAULTS };
  for (const k in out) if (typeof stored[k] === typeof out[k]) out[k] = stored[k];
  return out as unknown as Settings;
}

declare global { interface Window { __semanticFind?: boolean } }
if (!window.__semanticFind) {
  window.__semanticFind = true;
  // Listen before the async setup, so the first toggle sent right after injection is not lost.
  const toggle = init();
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'sf-toggle') void toggle.then((t) => t());
  });
}

async function init(): Promise<() => void> {
  const stored = (await chrome.storage.local.get('settings')).settings;
  const settings = loadSettings(stored);
  const save = () => void chrome.storage.local.set({ settings });
  if (Object.keys(stored ?? {}).some((k) => !(k in DEFAULTS))) save();

  // ---------- overlay ----------
  const host = document.createElement('div');
  host.id = 'semantic-find-host';
  host.style.cssText = 'all:initial;position:fixed;top:12px;right:12px;z-index:2147483647;display:none';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>${OVERLAY_CSS}</style>${OVERLAY_HTML}`;
  document.documentElement.append(host);
  const pageStyle = document.createElement('style');
  pageStyle.textContent = PAGE_CSS;
  document.head.append(pageStyle);

  const $ = <T extends HTMLElement>(id: string) => shadow.getElementById(id) as T;
  const input = $<HTMLInputElement>('q');
  const countEl = $('count'), statusEl = $('status'), devEl = $('dev'), listEl = $('list');
  const sliders = [...shadow.querySelectorAll<HTMLInputElement>('input[type=range]')];

  // ---------- state ----------
  let blocks: Block[] = [];
  let chunks: Chunk[] = [];
  let results: Result[] = [];
  let current = 0;
  let seq = 0; // bumped on every new search, stale async answers are dropped
  let timer = 0;
  let typedAt = 0;
  let index: { id: string; sig: string; done: Promise<void>; ms: number; ready: boolean } | null = null;

  const send = <T>(req: Request) =>
    chrome.runtime.sendMessage({ ...req, target: 'bg' }) as Promise<T | ErrorResponse>;

  // ---------- highlighting ----------
  function clearHighlights(): void {
    CSS.highlights.delete('sf-match');
    CSS.highlights.delete('sf-current');
  }

  function render(scroll = true): void {
    clearHighlights();
    countEl.textContent = results.length ? `${current + 1}/${results.length}` : '';
    const all: Range[] = [];
    results.forEach((r, i) => {
      const ranges = r.ranges.map(([b, s, e]) => toRange(blocks[b], s, e));
      if (i !== current) return void all.push(...ranges);
      const cur = new Highlight(...ranges);
      cur.priority = 1;
      CSS.highlights.set('sf-current', cur);
      if (scroll) ranges[0].startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'instant' });
    });
    CSS.highlights.set('sf-match', new Highlight(...all));
    renderList();
  }

  function renderList(): void {
    listEl.replaceChildren();
    if (!settings.dev) return;
    results.slice(0, 20).forEach((r, i) => {
      const li = document.createElement('li');
      if (i === current) li.className = 'current';
      const text = chunks[r.chunk].text.replace(/\s+/g, ' ');
      const scoreEl = document.createElement('b');
      scoreEl.textContent = `cos ${r.semantic.toFixed(2)} · fuzzy ${r.fuzzy.toFixed(2)} · hybrid ${r.hybrid.toFixed(2)}`;
      li.append(scoreEl, ` ${text.slice(0, 90)}`);
      li.onclick = () => { current = i; render(); };
      listEl.append(li);
    });
  }

  function step(delta: number): void {
    if (!results.length) return;
    current = (current + delta + results.length) % results.length;
    render();
  }

  // ---------- semantic search ----------
  function ensureIndex(): Promise<void> {
    const sig = `${chunks.length}:${chunks.reduce((n, c) => n + c.text.length, 0)}:${settings.minS}:${settings.maxS}`;
    if (index?.sig === sig) return index.done;
    const mine = { id: crypto.randomUUID(), sig, done: Promise.resolve(), ms: 0, ready: false };
    index = mine;
    const texts = chunks.map((c) => c.text);
    // Batches of similar length waste less time on padding.
    const order = texts.map((_, i) => i).sort((a, b) => texts[a].length - texts[b].length);
    mine.done = (async () => {
      const t0 = performance.now();
      let device = '';
      for (let i = 0; i < order.length; i += BATCH) {
        if (index !== mine) return; // superseded by a newer index
        statusEl.textContent = 'Indexing…';
        const ids = order.slice(i, i + BATCH);
        const r = await send<IndexResponse>({ type: 'index', indexId: mine.id, ids, texts: ids.map((id) => texts[id]) });
        if ('error' in r) throw new Error(r.error);
        device = r.device;
      }
      mine.ms = performance.now() - t0;
      mine.ready = true;
      if (index === mine && !input.value.trim()) statusEl.textContent = `Indexed ${texts.length} chunks in ${mine.ms.toFixed(0)} ms (${device})`;
    })();
    mine.done.catch(() => { if (index === mine) index = null; });
    return mine.done;
  }

  async function semanticSearch(query: string, mySeq: number): Promise<void> {
    try {
      await ensureIndex();
      if (mySeq !== seq || !index) return;
      statusEl.textContent = 'Searching…';
      const r = await send<QueryResponse>({ type: 'query', indexId: index.id, query });
      if (mySeq !== seq) return; // the user kept typing
      if ('error' in r) throw new Error(r.error);
      const qt = tokenize(query).map((t) => t.t);
      const caches = qt.map(() => new Map<string, number>());
      const fuzzy = chunks.map((c) => fuzzyMatch(qt, c.tokens, caches).score);
      const hybrid = hybridScores(r.scores, fuzzy, settings.weight);
      results = chunks
        .map((c, i): Result => ({ ranges: [[c.block, c.start, c.end]], chunk: i, fuzzy: fuzzy[i], semantic: r.scores[i], hybrid: hybrid[i] }))
        .filter((x) => isShown(x.semantic, x.fuzzy, settings.threshold))
        .sort((x, y) => y.hybrid - x.hybrid)
        .slice(0, MAX_RESULTS);
      current = 0;
      render();
      const took = `${(performance.now() - typedAt).toFixed(0)} ms`;
      statusEl.textContent = results.length ? (settings.dev ? `${took}, model ${r.ms.toFixed(0)} ms, index ${index.ms.toFixed(0)} ms` : '') : 'No good match';
    } catch (e) {
      if (mySeq === seq) statusEl.textContent = `Search failed: ${e instanceof Error ? e.message : e}`;
    }
  }

  // ---------- orchestration ----------
  function search(): void {
    const mySeq = ++seq;
    clearTimeout(timer);
    typedAt = performance.now();
    const query = input.value.trim();
    if (!query) {
      results = [];
      statusEl.textContent = '';
      return render();
    }
    // Highlights of the previous answer stay in place until the model answers.
    statusEl.textContent = index?.ready ? 'Searching…' : 'Indexing…';
    timer = window.setTimeout(() => void semanticSearch(query, mySeq), DEBOUNCE_MS);
  }

  function reindex(): void {
    blocks = extractBlocks(document.body, host);
    chunks = buildChunks(blocks, settings.minS, settings.maxS);
    // Results point into the old chunks.
    results = [];
    render(false);
    ensureIndex().catch((e) => { statusEl.textContent = `Indexing failed: ${e.message}`; });
  }

  function syncUi(): void {
    devEl.hidden = !settings.dev;
    sliders.forEach((s) => {
      const key = s.name as 'threshold' | 'minS' | 'maxS' | 'weight';
      s.value = String(settings[key]);
      s.nextElementSibling!.textContent = String(settings[key]);
    });
  }

  function open(): void {
    host.style.display = 'block';
    syncUi();
    reindex();
    input.focus();
    input.select();
    search();
  }
  function close(): void {
    seq++;
    clearTimeout(timer);
    host.style.display = 'none';
    clearHighlights();
  }

  // ---------- events ----------
  input.addEventListener('input', search);
  shadow.addEventListener('keydown', (ev) => {
    const e = ev as KeyboardEvent;
    e.stopPropagation(); // keep page shortcuts from firing while typing
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.altKey && e.code === 'KeyD') { e.preventDefault(); settings.dev = !settings.dev; save(); syncUi(); renderList(); }
  });
  $('next').onclick = () => step(1);
  $('prev').onclick = () => step(-1);
  $('close').onclick = close;
  sliders.forEach((s) => s.addEventListener('input', () => {
    const key = s.name as 'threshold' | 'minS' | 'maxS' | 'weight';
    settings[key] = Number(s.value);
    if (settings.minS > settings.maxS) settings[key === 'minS' ? 'maxS' : 'minS'] = settings[key];
    save();
    syncUi();
    if (key === 'minS' || key === 'maxS') reindex();
    search();
  }));

  return () => (host.style.display === 'none' ? open() : close());
}
