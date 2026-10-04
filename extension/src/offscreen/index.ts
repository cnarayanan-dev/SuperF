// Offscreen document: loads the bundled model once and serves every tab.
// It keeps the chunk vectors of a few indexes per tab, so only scores travel back to the page.
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { INDEX_NOT_FOUND, type Envelope } from '../messages.ts';
import { MODEL } from '../model.ts';
import { lruGet, lruSet, MAX_INDEXES } from '../search/lru.ts';
import { dot } from '../search/rank.ts';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = chrome.runtime.getURL('models/');
env.useBrowserCache = false;
env.backends.onnx.wasm!.wasmPaths = chrome.runtime.getURL('ort/');

let device = 'wasm';
let extractor: Promise<FeatureExtractionPipeline> | null = null;

// WebGPU when the machine has it, WASM otherwise.
async function load(): Promise<FeatureExtractionPipeline> {
  // The cast avoids a union type that is too complex for the compiler.
  const create = pipeline as (task: string, model: string, options: object) => Promise<FeatureExtractionPipeline>;
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (await gpu?.requestAdapter().catch(() => null)) {
    try {
      const p = await create('feature-extraction', MODEL.id, { dtype: MODEL.dtype, device: 'webgpu' });
      device = 'webgpu';
      return p;
    } catch (e) {
      console.warn('WebGPU failed, using WASM:', e);
    }
  }
  return create('feature-extraction', MODEL.id, { dtype: MODEL.dtype, device: 'wasm' });
}
function getExtractor(): Promise<FeatureExtractionPipeline> {
  extractor ??= load();
  return extractor;
}

async function embed(texts: string[]): Promise<Float32Array[]> {
  const model = await getExtractor();
  const out = await model(texts, { pooling: MODEL.pooling, normalize: true });
  const dims = out.dims[1];
  const data = out.data as Float32Array;
  return texts.map((_, i) => data.slice(i * dims, (i + 1) * dims));
}

interface Index { vecs: Float32Array[] }
// Per tab, the indexes by id, least recently used first. A tab has one index per configuration it tried.
const tabs = new Map<number, Map<string, Index>>();

async function handle(msg: Envelope): Promise<unknown> {
  const tabId = msg.tabId!;
  const t0 = performance.now();
  if (msg.type === 'drop') {
    tabs.delete(tabId);
    return { ok: true };
  }
  if (msg.type === 'index') {
    let indexes = tabs.get(tabId);
    if (!indexes) tabs.set(tabId, (indexes = new Map()));
    let entry = lruGet(indexes, msg.indexId);
    if (!entry) lruSet(indexes, msg.indexId, (entry = { vecs: [] }), MAX_INDEXES);
    const { vecs } = entry;
    (await embed(msg.texts)).forEach((v, i) => { vecs[msg.ids[i]] = v; });
    return { ok: true, ms: performance.now() - t0, device: `${device} ${MODEL.dtype}` };
  }
  const entry = lruGet(tabs.get(tabId) ?? new Map<string, Index>(), msg.indexId);
  if (!entry) return { error: INDEX_NOT_FOUND };
  const [q] = await embed([MODEL.queryPrefix + msg.query]);
  const scores = entry.vecs.map((v) => Math.round(dot(q, v) * 1e4) / 1e4);
  return { scores, ms: performance.now() - t0 };
}

// One inference at a time. The ONNX session does not run concurrent calls.
let queue: Promise<unknown> = Promise.resolve();
chrome.runtime.onMessage.addListener((msg: Envelope, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  const run = queue.then(() => handle(msg));
  queue = run.catch(() => {});
  run.then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true;
});
