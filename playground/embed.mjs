// Embed a few sentences and print a cosine similarity matrix.
// Usage: node embed.mjs [--model <id>] [--dtype q8|q4|fp32]
import { pipeline } from "@huggingface/transformers";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const modelId = opt("model", "Xenova/all-MiniLM-L6-v2");
const dtype = opt("dtype", "q8");

const sentences = [
  "The cat sat on the sofa.",                       // 0 base
  "The cat sat on the sofaa and slept.",            // 1 typo-ish variant of 0
  "How much does the subscription cost?",           // 2 synonym pair with 3
  "What is the price of the monthly plan?",         // 3
  "I want to cancel my membership.",                // 4 paraphrase pair with 5
  "How do I end my subscription?",                  // 5
  "The stock market fell sharply on Monday.",       // 6 unrelated
  "Die Katze sass auf dem Sofa.",                   // 7 German version of 0
];

// Model specific prefixes. e5 needs "query: " or "passage: ", bge wants an instruction on queries only.
// Here every sentence is treated symmetrically, so e5 gets "query: " and bge gets no prefix.
const prefix = /e5/i.test(modelId) ? "query: " : "";
const inputs = sentences.map((s) => prefix + s);

const t0 = performance.now();
const extractor = await pipeline("feature-extraction", modelId, { dtype });
const tLoad = performance.now() - t0;

const t1 = performance.now();
const out = await extractor(inputs, { pooling: "mean", normalize: true });
const tEmbed = performance.now() - t1;

const vecs = out.tolist(); // normalized, so dot product equals cosine similarity
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

console.log(`model: ${modelId} (${dtype}), dims: ${vecs[0].length}`);
console.log(`load: ${tLoad.toFixed(0)} ms, embed ${sentences.length} sentences: ${tEmbed.toFixed(0)} ms\n`);
sentences.forEach((s, i) => console.log(`  ${i}  ${s}`));

console.log("\n     " + sentences.map((_, i) => String(i).padStart(5)).join(" "));
vecs.forEach((a, i) => {
  const row = vecs.map((b) => dot(a, b).toFixed(2).padStart(5)).join(" ");
  console.log(`  ${i}  ${row}`);
});
