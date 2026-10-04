// Download the model files from Hugging Face into extension/models/ so they can be bundled.
// Usage: node scripts/fetch-model.mjs [model id]
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const modelId = process.argv[2] ?? 'Xenova/all-MiniLM-L6-v2';
const files = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_fp16.onnx'];
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'models', modelId);

for (const f of files) {
  const dest = join(root, f);
  if (existsSync(dest) && statSync(dest).size > 0) { console.log(`have  ${f}`); continue; }
  const res = await fetch(`https://huggingface.co/${modelId}/resolve/main/${f}`);
  if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  console.log(`saved ${f} (${(buf.length / 1e6).toFixed(2)} MB)`);
}
