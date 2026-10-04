# How Semantic Find works

A short guide for developers new to embeddings.

## 1. Embeddings

An embedding model turns a piece of text into a list of numbers, called a vector. For `all-MiniLM-L6-v2` that is 384 numbers. The model is trained so that texts with similar meaning get vectors pointing in similar directions.

"How do I end my subscription?" and "I want to cancel my membership" share almost no words, but their vectors end up close together. This is what lets the extension find a passage by meaning.

## 2. Cosine similarity

To compare two vectors we measure the angle between them:

```
cos(a, b) = (a . b) / (|a| * |b|)
```

The result is 1 for the same direction, 0 for unrelated, and negative for opposite. Most sentence models give values between about 0.1 and 0.9 in practice.

Toy example with 2 dimensions instead of 384:

| Text | Vector |
|---|---|
| "cancel my membership" | (0.9, 0.1) |
| "end my subscription" | (0.8, 0.2) |
| "stock market fell" | (0.1, 0.9) |

The first two point almost the same way, so cosine is about 0.99. The third points elsewhere, so cosine with the first is about 0.22. Real vectors work the same way, only with more axes.

If vectors are normalized to length 1 (we do this with `normalize: true`), cosine similarity is just the dot product. That makes ranking thousands of chunks very cheap.

## 3. Chunking

We cannot embed a whole page as one vector, because the meaning would be averaged into mush. We split it into chunks and embed each one. Each chunk stores a pointer to the DOM node and text offsets it came from, so we can highlight and scroll to it.

| Choice | Pros | Cons |
|---|---|---|
| 1 sentence | Precise highlight, short inputs, fast | Little context ("It costs 5 dollars" says nothing alone) |
| 2 to 3 sentences | More context, better for paraphrase queries | Fuzzier highlight, more tokens per chunk |
| Overlap (one sentence shared) | An answer split across a boundary is still found | More chunks to embed, duplicate hits to merge |

Practical rules:
- Never merge text across block elements (paragraph, list item, heading). Chunks stay inside one DOM node where possible.
- A chunk that spans several inline nodes (`<b>`, `<a>`) keeps a list of text node ranges so highlighting can wrap them.
- Models truncate long input (often 256 or 512 tokens), so keep chunks around 30 to 100 words.
- Which size wins is an open question, and the benchmark will decide.

## 4. Why hybrid search

Embeddings are good at meaning and weak at spelling. A typo like "optmization" gets split into odd word pieces, so its vector can drift far from "optimization". Short single-word queries also carry little meaning to embed.

Fuzzy string matching (edit distance) is the opposite. It nails typos and exact words but knows nothing about synonyms.

| Query type | Fuzzy | Semantic |
|---|---|---|
| exact | strong | good |
| typo | strong | often weak |
| variant (optimise/optimization) | good | good |
| synonym (cost/price) | fails | strong |
| paraphrase | fails | strong |

So we compute both scores per chunk and merge them, for example `score = w * semantic + (1 - w) * fuzzy`. The weight `w` may depend on query length (short queries lean fuzzy, long ones lean semantic). The benchmark tunes this.

## 5. Quantization

Model weights are stored as numbers. Fewer bits per number means a smaller download and faster load, at a small accuracy cost.

| Type | Bits | Size of MiniLM-L6 (approx.) | Accuracy |
|---|---|---|---|
| fp32 | 32 | ~90 MB | Reference |
| q8 (int8) | 8 | ~23 MB | Usually within 1 percent of fp32 |
| q4 | 4 | smaller still | Larger drop, test before trusting |

We default to q8 because it cuts size about 4x with little ranking loss. Verify on our own benchmark rather than assuming. Size figures are approximate.

## 6. WebGPU vs WASM

Transformers.js runs models through ONNX Runtime Web with two backends.

- **WebGPU** uses the graphics card. Much faster for indexing many chunks, but not available everywhere and has startup cost for shader compilation.
- **WASM** runs on the CPU. Works in every modern Chrome and is fast enough for small models and short queries.

We try WebGPU first and fall back to WASM. For a single query embedding (one short string) the difference is small. For indexing hundreds of chunks it matters most. We will measure both in the benchmark. Extensions also need `'wasm-unsafe-eval'` in the CSP, and the model runs in an offscreen document.

## 7. Model-specific prefixes

Some models were trained with a marker telling them what role the text plays. Skipping it quietly hurts quality.

| Model | Query | Document chunk |
|---|---|---|
| all-MiniLM-L6-v2 | none | none |
| bge-small-en-v1.5 | `Represent this sentence for searching relevant passages: ` | none |
| gte-small | none | none |
| multilingual-e5-small (not used in v1) | `query: ` | `passage: ` |

Always check the model card. Note the asymmetry: the prefix goes on the query side for bge, and on both sides (different values) for e5.

## 8. Worked example

`playground/embed.mjs` embeds 8 sentences and prints the matrix:

| # | Sentence | Role |
|---|---|---|
| 0 | The cat sat on the sofa. | base |
| 1 | The cat sat on the sofaa and slept. | typo pair with 0 |
| 2 | How much does the subscription cost? | synonym pair with 3 |
| 3 | What is the price of the monthly plan? | synonym pair with 2 |
| 4 | I want to cancel my membership. | paraphrase pair with 5 |
| 5 | How do I end my subscription? | paraphrase pair with 4 |
| 6 | The stock market fell sharply on Monday. | unrelated |
| 7 | Die Katze sass auf dem Sofa. | German version of 0 |

### Real output

**Not available yet.** The sandbox this was written in blocks `huggingface.co` (the egress proxy answers 403 to the CONNECT request), so the model could not be downloaded and the script stopped at the tokenizer load. No numbers are shown here on purpose, because invented numbers would mislead.

To fill this in, run on a machine with normal internet access:

```
cd playground
npm install
node embed.mjs
```

and paste the matrix below.

### What to look for

These are things to check in the real matrix, not results:
- Rows 2/3 and 4/5 (synonym and paraphrase) should score clearly higher than either does against row 6 (unrelated). That is the case for semantic search.
- Row 0 vs row 1 (typo-ish variant) should be high, but a typo inside a single query word is a harder test. Try swapping in a misspelled single word and compare with an edit distance score. Expect semantic to be less reliable there, which motivates the hybrid design.
- Row 0 vs row 7 (German): `all-MiniLM-L6-v2` is English only, so expect a weak score. v1 is English only, so this row just shows the limit.
- Compare `--dtype q8` with `--dtype fp32` to see the quantization effect on individual scores.
