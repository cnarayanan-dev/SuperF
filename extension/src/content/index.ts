// Content script: overlay UI, search orchestration and highlighting.
import { fuzzyMatch, tokenize } from '../search/fuzzy.ts';
import { bestWindow, chunkRanges, clampOverlap } from '../search/chunks.ts';
import { lruGet, lruSet, MAX_INDEXES, textSignature } from '../search/lru.ts';
import { hybridScores, isShown } from '../search/rank.ts';
import { INDEX_NOT_FOUND, type ErrorResponse, type IndexResponse, type QueryResponse, type Request, type SentencesResponse } from '../messages.ts';
import { MODEL } from '../model.ts';
import { buildChunks, extractBlocks, toRange, type Block, type Chunk } from './dom.ts';
import { OVERLAY_CSS, OVERLAY_HTML, PAGE_CSS } from './ui.ts';

interface Settings {
  threshold: number;
  weight: number;
  chunkLength: number;
  overlap: number;
  cross: boolean; // chunks may cross paragraph borders
  highlightLength: number;
  panel: boolean;
}
type SliderKey = 'threshold' | 'weight' | 'chunkLength' | 'overlap' | 'highlightLength';
// The index of one chunk configuration on one page text, held as vectors in the offscreen document.
interface Index { id: string; key: string; done: Promise<void>; ms: number; device: string; ready: boolean; reused: boolean }
// The scores of one answered query on the index in use.
interface Answer {
  query: string;
  semantic: number[];
  fuzzy: number[];
  tookMs: number; // keystroke to result
  modelMs: number;
  sentences: Map<number, number[]>; // semantic score per sentence, for chunks longer than the highlight
  asked: Set<number>; // chunks whose sentence scores are requested or in
  highlight: { modelMs: number; tookMs: number } | 'pending' | null; // the second model call, if one was needed
}
interface Result {
  chunk: number;
  fuzzy: number;
  semantic: number;
  hybrid: number;
}

const DEFAULTS: Settings = { threshold: MODEL.defaultThreshold, weight: 0.7, chunkLength: 2, overlap: 0, cross: false, highlightLength: 2, panel: false };
const DEBOUNCE_MS = 150;
const BATCH = 32;
const MAX_RESULTS = 10;

// Stored keys from earlier builds (like "mode", "dev" or "minS") are ignored, missing ones fall back to the defaults.
// Values outside the range of their slider are pulled back into it.
function loadSettings(stored: Record<string, unknown> | null | undefined): Settings {
  const pick = <K extends keyof Settings>(k: K): Settings[K] => {
    const v = stored?.[k];
    return typeof v === typeof DEFAULTS[k] && !Number.isNaN(v) ? (v as Settings[K]) : DEFAULTS[k];
  };
  const within = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
  const chunkLength = within(Math.round(pick('chunkLength')), 1, 6);
  return {
    threshold: within(pick('threshold'), 0, 1),
    weight: within(pick('weight'), 0, 1),
    chunkLength,
    overlap: clampOverlap(chunkLength, within(Math.round(pick('overlap')), 0, 2)),
    cross: pick('cross'),
    highlightLength: within(Math.round(pick('highlightLength')), 1, 3),
    panel: pick('panel'),
  };
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
  const crossEl = $<HTMLInputElement>('cross');

  // ---------- state ----------
  let blocks: Block[] = [];
  let chunks: Chunk[] = [];
  let results: Result[] = [];
  let current = 0;
  let seq = 0; // bumped on every new search, stale async answers are dropped
  let timer = 0;
  let pending = false; // a search is waiting for the debounce or the model
  let chunked = ''; // chunk length, overlap and crossing the chunks were built with
  let indexKey = ''; // identifies the chunks: what they were built with, plus a signature of the page text
  let typedAt = 0;
  let index: Index | null = null; // the one in use
  const indexes = new Map<string, Index>(); // by index key, least recently used first
  // The last model answer. Threshold and weight changes re-rank it without a model call.
  let answer: Answer | null = null;

  const send = <T>(req: Request) =>
    chrome.runtime.sendMessage({ ...req, target: 'bg' }) as Promise<T | ErrorResponse>;
  // Indexes of an earlier page load in this tab cannot be reached any more.
  void send({ type: 'drop' }).catch(() => {});

  // ---------- highlighting ----------
  function clearHighlights(): void {
    CSS.highlights.delete('sf-match');
    CSS.highlights.delete('sf-current');
  }

  // The part of a result that is marked, as one range per paragraph it touches. A chunk longer than the
  // highlight length is marked whole until its sentence scores are in, then the best run of sentences is.
  function highlightOf(r: Result): [block: number, start: number, end: number][] {
    const { spans } = chunks[r.chunk];
    const scores = answer?.sentences.get(r.chunk);
    if (spans.length <= settings.highlightLength || !scores) return chunkRanges(spans);
    return chunkRanges(spans.slice(...bestWindow(scores, settings.highlightLength)));
  }

  function render(scroll = true): void {
    clearHighlights();
    countEl.textContent = results.length ? `${current + 1}/${results.length}` : '';
    const all: Range[] = [];
    results.forEach((r, i) => {
      const ranges = highlightOf(r).map(([b, s, e]) => toRange(blocks[b], s, e));
      if (i !== current) return void all.push(...ranges);
      const cur = new Highlight(...ranges);
      cur.priority = 1;
      CSS.highlights.set('sf-current', cur);
      if (scroll) ranges[0].startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'instant' });
    });
    CSS.highlights.set('sf-match', new Highlight(...all));
    renderPanel();
  }

  // How the highlights of the shown results were picked, as a line for the settings panel.
  function highlightStat(): string {
    if (!results.length) return '';
    const picked = answer?.highlight;
    const long = results.some((r) => chunks[r.chunk].spans.length > settings.highlightLength);
    if (!long) return '\nHighlight: whole chunk, no model call';
    if (picked === 'pending') return '\nHighlight: by sentence…';
    if (!picked) return '\nHighlight: whole chunk';
    const after = picked.tookMs ? `, ${picked.tookMs.toFixed(0)} ms after keystroke` : '';
    return `\nHighlight: by sentence, model ${picked.modelMs.toFixed(0)} ms${after}`;
  }

  // The result list and the numbers in the settings panel. Costs nothing while the panel is closed.
  function renderPanel(): void {
    if (!settings.panel) return;
    const ms = (n: number) => `${n.toFixed(0)} ms`;
    const indexed = index?.ready ? `, indexed in ${ms(index.ms)} (${index.device})${index.reused ? ', reused' : ''}` : '';
    const timing = answer ? `\nResult in ${ms(answer.tookMs)}, model ${ms(answer.modelMs)}` : '';
    statsEl.textContent = `${chunks.length} chunks${indexed}${timing}${highlightStat()}`;
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
    const key = indexKey;
    const known = lruGet(indexes, key);
    if (known) {
      // A configuration that was already tried on this page text comes back without embedding anything.
      if (known !== index) known.reused = known.ready;
      index = known;
      return known.done;
    }
    const mine: Index = { id: crypto.randomUUID(), key, done: Promise.resolve(), ms: 0, device: '', ready: false, reused: false };
    index = mine;
    // The offscreen document keeps exactly the indexes this map holds.
    const forgetOffscreen = (x: Index) => void send({ type: 'forget', indexId: x.id }).catch(() => {});
    lruSet(indexes, key, mine, MAX_INDEXES).forEach(forgetOffscreen);
    const forget = () => {
      if (indexes.get(key) === mine) indexes.delete(key);
      forgetOffscreen(mine);
    };
    const texts = chunks.map((c) => c.text);
    // Batches of similar length waste less time on padding.
    const order = texts.map((_, i) => i).sort((a, b) => texts[a].length - texts[b].length);
    mine.done = (async () => {
      const t0 = performance.now();
      for (let i = 0; i < order.length; i += BATCH) {
        if (index !== mine) return forget(); // superseded while incomplete, so it cannot be reused
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
    mine.done.catch(() => { forget(); if (index === mine) index = null; });
    return mine.done;
  }

  // Turns the last model answer into results with the current threshold and weight.
  function rank(): void {
    if (!answer) return;
    pending = false;
    const { semantic, fuzzy } = answer;
    const hybrid = hybridScores(semantic, fuzzy, settings.weight);
    results = chunks
      .map((_, i): Result => ({ chunk: i, fuzzy: fuzzy[i], semantic: semantic[i], hybrid: hybrid[i] }))
      .filter((x) => isShown(x.semantic, x.fuzzy, settings.threshold))
      .sort((x, y) => y.hybrid - x.hybrid)
      .slice(0, MAX_RESULTS);
    current = 0;
    render();
    statusEl.textContent = results.length ? '' : 'No good match';
  }

  // Second model call: scores the sentences of the shown results that are longer than the highlight
  // length. The offscreen document keeps the sentence vectors, so a later query only needs scoring.
  async function pickHighlights(fromKeystroke = false): Promise<void> {
    const mine = answer;
    if (!mine || !index) return;
    const need = results.map((r) => r.chunk).filter((c) => chunks[c].spans.length > settings.highlightLength && !mine.asked.has(c));
    if (!need.length) return;
    need.forEach((c) => mine.asked.add(c));
    const mySeq = seq;
    const before = mine.highlight;
    mine.highlight = 'pending';
    renderPanel();
    const texts = (c: number) => chunks[c].spans.map((s) => blocks[s.paragraph].text.slice(s.start, s.end));
    const r = await send<SentencesResponse>({ type: 'sentences', indexId: index.id, query: mine.query, chunks: need.map((chunk) => ({ chunk, texts: texts(chunk) })) })
      .catch((e): ErrorResponse => ({ error: String(e) }));
    if (mySeq !== seq || answer !== mine || 'error' in r) {
      // The user kept typing, the page was indexed again, or the call failed. The whole chunk stays highlighted.
      need.forEach((c) => mine.asked.delete(c));
      mine.highlight = before === 'pending' ? null : before;
      if (answer === mine) renderPanel();
      return;
    }
    need.forEach((chunk, i) => mine.sentences.set(chunk, r.scores[i]));
    mine.highlight = { modelMs: r.ms, tookMs: fromKeystroke ? performance.now() - typedAt : 0 };
    render();
  }

  async function semanticSearch(query: string, mySeq: number): Promise<void> {
    try {
      await ensureIndex();
      if (mySeq !== seq || !index) return;
      statusEl.textContent = 'Searching…';
      let r = await send<QueryResponse>({ type: 'query', indexId: index.id, query });
      if (mySeq !== seq) return; // the user kept typing
      if ('error' in r && r.error === INDEX_NOT_FOUND) {
        // The offscreen document no longer has this index. Build it again, once.
        indexes.delete(index.key);
        index = null;
        await ensureIndex();
        if (mySeq !== seq || !index) return;
        r = await send<QueryResponse>({ type: 'query', indexId: (index as Index).id, query });
        if (mySeq !== seq) return;
      }
      if ('error' in r) throw new Error(r.error);
      const qt = tokenize(query).map((t) => t.t);
      const caches = qt.map(() => new Map<string, number>());
      const fuzzy = chunks.map((c) => fuzzyMatch(qt, c.tokens, caches).score);
      answer = { query, semantic: r.scores, fuzzy, tookMs: performance.now() - typedAt, modelMs: r.ms, sentences: new Map(), asked: new Set(), highlight: null };
      rank();
      void pickHighlights(true);
    } catch (e) {
      if (mySeq !== seq) return;
      pending = false;
      statusEl.textContent = `Search failed: ${e instanceof Error ? e.message : e}`;
    }
  }

  // ---------- orchestration ----------
  function search(): void {
    const mySeq = ++seq;
    clearTimeout(timer);
    typedAt = performance.now();
    const query = input.value.trim();
    pending = !!query;
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

  const chunkConfig = () => `${settings.chunkLength}:${settings.overlap}:${settings.cross}`;

  function reindex(): void {
    blocks = extractBlocks(document.body, host);
    chunks = buildChunks(blocks, settings.chunkLength, settings.overlap, settings.cross);
    chunked = chunkConfig();
    // Everything that changes the chunks is part of the key. Highlight and ranking settings are not.
    // It is fixed here with the chunks, as a slider can move on before the page is indexed again.
    indexKey = `${chunked}|${textSignature(blocks.map((b) => b.text))}`;
    // Results and scores point into the old chunks.
    results = [];
    answer = null;
    render(false);
    ensureIndex().catch((e) => { statusEl.textContent = `Indexing failed: ${e.message}`; });
  }

  function syncUi(): void {
    panelEl.hidden = !settings.panel;
    settingsButton.setAttribute('aria-expanded', String(settings.panel));
    crossEl.checked = settings.cross;
    sliders.forEach((s) => {
      const key = s.name as SliderKey;
      s.value = String(settings[key]);
      s.nextElementSibling!.textContent = String(settings[key]);
    });
  }

  async function open(): Promise<void> {
    host.style.display = 'block';
    $('model').textContent = MODEL.id;
    // Another tab may have changed the settings since this page loaded them.
    Object.assign(settings, loadSettings((await chrome.storage.local.get('settings')).settings));
    if (host.style.display === 'none') return; // closed again in the meantime
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
  crossEl.addEventListener('change', () => {
    settings.cross = crossEl.checked;
    save();
    reindex();
    search();
  });
  sliders.forEach((s) => {
    const key = s.name as SliderKey;
    const rechunks = key === 'chunkLength' || key === 'overlap';
    s.addEventListener('input', () => {
      settings[key] = Number(s.value);
      settings.overlap = clampOverlap(settings.chunkLength, settings.overlap);
      save();
      syncUi();
      if (rechunks) return; // chunk settings wait for the release of the slider
      // Highlight length keeps the results and only redoes the highlights.
      if (key === 'highlightLength') { render(); return void pickHighlights(); }
      // Threshold and weight re-rank at once, without a model call.
      // While a search is pending, its answer is ranked with the new values anyway.
      if (!pending) return answer ? rank() : search();
    });
    s.addEventListener('change', () => {
      // Results that came in while sweeping threshold or weight are narrowed on release.
      if (!rechunks) return void (pending || pickHighlights());
      if (chunkConfig() === chunked) return; // clamped back to what is already indexed
      reindex();
      search();
    });
  });

  return () => (host.style.display === 'none' ? void open() : close());
}
