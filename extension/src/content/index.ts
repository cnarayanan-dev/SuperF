// Content script: overlay UI, search orchestration and highlighting.
import { fuzzyMatch, tokenize } from '../search/fuzzy.ts';
import { hybridScores, isShown } from '../search/rank.ts';
import type { ErrorResponse, IndexResponse, QueryResponse, Request } from '../messages.ts';
import { MODEL } from '../model.ts';
import { buildChunks, extractBlocks, toRange, type Block, type Chunk } from './dom.ts';
import { OVERLAY_CSS, OVERLAY_HTML, PAGE_CSS } from './ui.ts';

interface Settings { threshold: number; minS: number; maxS: number; weight: number; panel: boolean }
type SliderKey = 'threshold' | 'minS' | 'maxS' | 'weight';
interface Result {
  ranges: [block: number, start: number, end: number][];
  chunk: number;
  fuzzy: number;
  semantic: number;
  hybrid: number;
}

const DEFAULTS: Settings = { threshold: MODEL.defaultThreshold, minS: 1, maxS: 2, weight: 0.7, panel: false };
const DEBOUNCE_MS = 150;
const BATCH = 32;
const MAX_RESULTS = 10;

// Stored keys from earlier builds (like "mode" and "dev") are ignored, missing ones fall back to the defaults.
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
  const countEl = $('count'), statusEl = $('status'), panelEl = $('panel'), listEl = $('list');
  const settingsButton = $('settings'), statsEl = $('stats');
  const sliders = [...shadow.querySelectorAll<HTMLInputElement>('input[type=range]')];

  // ---------- state ----------
  let blocks: Block[] = [];
  let chunks: Chunk[] = [];
  let results: Result[] = [];
  let current = 0;
  let seq = 0; // bumped on every new search, stale async answers are dropped
  let timer = 0;
  let typedAt = 0;
  let index: { id: string; sig: string; done: Promise<void>; ms: number; device: string; ready: boolean } | null = null;
  // The last model answer. Threshold and weight changes re-rank it without a model call.
  let answer: { semantic: number[]; fuzzy: number[]; tookMs: number; modelMs: number } | null = null;

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
    renderPanel();
  }

  // The result list and the numbers in the settings panel. Costs nothing while the panel is closed.
  function renderPanel(): void {
    if (!settings.panel) return;
    const indexed = index?.ready ? `, indexed in ${index.ms.toFixed(0)} ms (${index.device})` : '';
    const timing = answer ? `\nResult in ${answer.tookMs.toFixed(0)} ms, model ${answer.modelMs.toFixed(0)} ms` : '';
    statsEl.textContent = `${chunks.length} chunks${indexed}${timing}`;
    listEl.replaceChildren();
    results.forEach((r, i) => {
      const li = document.createElement('li');
      if (i === current) li.className = 'current';
      const text = chunks[r.chunk].text.replace(/\s+/g, ' ');
      const scoreEl = document.createElement('b');
      scoreEl.textContent = `semantic ${r.semantic.toFixed(2)} · fuzzy ${r.fuzzy.toFixed(2)} · blended ${r.hybrid.toFixed(2)}`;
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
    const mine = { id: crypto.randomUUID(), sig, done: Promise.resolve(), ms: 0, device: '', ready: false };
    index = mine;
    const texts = chunks.map((c) => c.text);
    // Batches of similar length waste less time on padding.
    const order = texts.map((_, i) => i).sort((a, b) => texts[a].length - texts[b].length);
    mine.done = (async () => {
      const t0 = performance.now();
      for (let i = 0; i < order.length; i += BATCH) {
        if (index !== mine) return; // superseded by a newer index
        statusEl.textContent = 'Indexing…';
        const ids = order.slice(i, i + BATCH);
        const r = await send<IndexResponse>({ type: 'index', indexId: mine.id, ids, texts: ids.map((id) => texts[id]) });
        if ('error' in r) throw new Error(r.error);
        mine.device = r.device;
      }
      mine.ms = performance.now() - t0;
      mine.ready = true;
      if (index !== mine) return;
      if (!input.value.trim()) statusEl.textContent = '';
      renderPanel();
    })();
    mine.done.catch(() => { if (index === mine) index = null; });
    return mine.done;
  }

  // Turns the last model answer into results with the current threshold and weight.
  function rank(): void {
    if (!answer) return;
    const { semantic, fuzzy } = answer;
    const hybrid = hybridScores(semantic, fuzzy, settings.weight);
    results = chunks
      .map((c, i): Result => ({ ranges: [[c.block, c.start, c.end]], chunk: i, fuzzy: fuzzy[i], semantic: semantic[i], hybrid: hybrid[i] }))
      .filter((x) => isShown(x.semantic, x.fuzzy, settings.threshold))
      .sort((x, y) => y.hybrid - x.hybrid)
      .slice(0, MAX_RESULTS);
    current = 0;
    render();
    statusEl.textContent = results.length ? '' : 'No good match';
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
      answer = { semantic: r.scores, fuzzy, tookMs: performance.now() - typedAt, modelMs: r.ms };
      rank();
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
      answer = null;
      statusEl.textContent = index && !index.ready ? 'Indexing…' : '';
      return render();
    }
    // Highlights of the previous answer stay in place until the model answers.
    statusEl.textContent = index?.ready ? 'Searching…' : 'Indexing…';
    timer = window.setTimeout(() => void semanticSearch(query, mySeq), DEBOUNCE_MS);
  }

  function reindex(): void {
    blocks = extractBlocks(document.body, host);
    chunks = buildChunks(blocks, settings.minS, settings.maxS);
    // Results and scores point into the old chunks.
    results = [];
    answer = null;
    render(false);
    ensureIndex().catch((e) => { statusEl.textContent = `Indexing failed: ${e.message}`; });
  }

  function syncUi(): void {
    panelEl.hidden = !settings.panel;
    settingsButton.setAttribute('aria-expanded', String(settings.panel));
    sliders.forEach((s) => {
      const key = s.name as SliderKey;
      s.value = String(settings[key]);
      s.nextElementSibling!.textContent = String(settings[key]);
    });
  }

  function open(): void {
    host.style.display = 'block';
    $('model').textContent = MODEL.id;
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
  });
  $('next').onclick = () => step(1);
  $('prev').onclick = () => step(-1);
  $('close').onclick = close;
  settingsButton.onclick = () => {
    settings.panel = !settings.panel;
    save();
    syncUi();
    renderPanel();
    input.focus();
  };
  $('reset').onclick = () => {
    Object.assign(settings, DEFAULTS, { panel: settings.panel });
    save();
    syncUi();
    reindex();
    search();
  };
  sliders.forEach((s) => s.addEventListener('input', () => {
    const key = s.name as SliderKey;
    settings[key] = Number(s.value);
    if (settings.minS > settings.maxS) settings[key === 'minS' ? 'maxS' : 'minS'] = settings[key];
    save();
    syncUi();
    if (key === 'threshold' || key === 'weight') return answer ? rank() : search();
    reindex();
    search();
  }));

  return () => (host.style.display === 'none' ? open() : close());
}
