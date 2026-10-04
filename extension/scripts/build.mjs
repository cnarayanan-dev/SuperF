// Bundle the extension into dist/. Load dist/ as an unpacked extension in Chrome.
import { build } from 'esbuild';
import { cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const models = join(root, 'models');
if (!existsSync(models)) throw new Error('models/ is missing. Run "npm run fetch-model" first.');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

const common = { bundle: true, target: 'chrome116', logLevel: 'info', absWorkingDir: root };
await build({ ...common, entryPoints: { content: 'src/content/index.ts' }, outdir: dist, format: 'iife' });
await build({
  ...common,
  entryPoints: { background: 'src/background/index.ts', offscreen: 'src/offscreen/index.ts' },
  outdir: dist,
  format: 'esm',
});

cpSync(join(root, 'static'), dist, { recursive: true });
cpSync(models, join(dist, 'models'), { recursive: true });
// ONNX Runtime loads its WASM binary at runtime. Ship it so nothing comes from a CDN.
const ort = join(root, 'node_modules/@huggingface/transformers/dist');
mkdirSync(join(dist, 'ort'));
for (const f of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) cpSync(join(ort, f), join(dist, 'ort', f));
console.log('built dist/');
