# Semantic Find: smarter in-page search for Chrome

## Goal

Build a Chrome extension that improves Cmd+F. It finds the word or passage a user is looking for even when the query has typos, uses a different spelling, or describes the meaning instead of the exact words. Everything runs locally in the browser with a small embedding model. No server, no data leaves the machine.

Success means:
- Finds the right passage for typo, synonym and paraphrase queries where Cmd+F fails
- Indexes a 5,000 to 10,000 word page in under 1 second on an Apple M-series MacBook (WebGPU)
- Shows results within 250 ms of the last keystroke (search runs as you type)
- Users find things faster than with Cmd+F (measured, not assumed)

## Decisions for v1

- **English only.** German and other languages come later.
- **Semantic search only.** The overlay has no mode switch and no `Word` mode. Cmd+F stays the browser's own find and is the fallback for exact matching.
- **Search per keystroke.** Each keystroke starts one semantic search after a short debounce (about 150 ms). Until the model answers, the status line shows "Indexing…" or "Searching…" and the highlights of the previous answer stay in place. On the first search on a page nothing is highlighted until the answer arrives. An empty query clears the highlights. Answers to an older query are dropped. Budget: results visible within 250 ms of the last keystroke.
- **Score threshold.** Only show semantic results with cosine similarity of at least 0.35 (default for MiniLM, adjustable by slider). No result is better than a wrong one. Show "no good match" instead. Scores differ between models, so the threshold is set per model in `extension/src/model.ts` and the benchmark reports a calibrated value for each. The first plan was 0.6, but that hid 21 of 25 correct MiniLM answers on the model-pick test set. Passages with a strong fuzzy score (0.8 or more, `STRONG_FUZZY` in `extension/src/search/rank.ts`) are shown even below the threshold. That covers literal matches and typo queries like "bandwitdh", which `Word` mode used to serve.
- **Result order.** Results are sorted by similarity, highest first. The best match is selected and scrolled into view. Enter moves to the next best.
- **Highlight size.** Highlight length is its own setting (1 to 3 sentences, default 2), separate from chunk length. A chunk no longer than the highlight length is highlighted whole, with no extra model call. A longer chunk is first highlighted whole. A second model call then scores the sentences of the shown results against the query, and the highlight becomes the run of consecutive sentences with the highest summed semantic score. Sentence vectors are kept with the index. Picking is semantic, not fuzzy. Measured on WebGPU (M-series, 8,800 word page, 10 results, chunk length 4 and 6): the second call takes 22 to 97 ms the first time a chunk is shown and about 0 ms afterwards. Results land 167 to 215 ms after the last keystroke. The narrowed highlight lands 203 to 291 ms after it on the first query that shows a chunk, and 171 to 194 ms on later ones. So the first narrowing can miss the 250 ms budget by up to about 40 ms, while the results themselves stay inside it. At the default settings (chunk length 2, highlight length 2) there is no second call.
- **Settings panel.** A Settings button in the overlay opens a panel with sliders for chunk length (1 to 6 sentences), overlap (0 to 2, always less than chunk length), highlight length, score threshold and semantic weight. Chunk length and overlap index the page again when the slider is released. Highlight length only redoes the highlights. It lists the results with semantic, fuzzy and blended score, and shows the chunk count, indexing time and device, keystroke to result time, model time and model name. Threshold and weight re-rank without a model call. Reset restores the defaults. Settings and the open state of the panel are stored locally.
- **Index per configuration.** An index is identified by the tab, the chunk length, the overlap and a signature of the page text. The offscreen document keeps up to 4 indexes per tab and drops the least recently used. Going back to a configuration that was already tried on the page embeds nothing, and the panel marks the index as "reused". Closing the tab drops all its indexes. Indexes are not kept across page loads.
- **Shortcut**: Cmd+Shift+K for v1 (Ctrl+Shift+K on Windows and Linux). Cmd+Shift+F and Cmd+Shift+J were tried first but are blocked in Chrome, so they were dropped.
- **Model for v1**: `Xenova/all-MiniLM-L6-v2`.
- **Model weights are bundled** in the extension (decided). `npm run fetch-model` downloads them from Hugging Face once at build time. No download at runtime, no host permission, works offline from the first use.
- **Weights are fp16** (45 MB for MiniLM), not q8. WebGPU cannot speed up q8 weights. On a 12,300 word page, indexing took 1.1 s with fp16 on WebGPU and 5.8 s with q8 on WASM. The same fp16 file also runs on the WASM fallback.
- **Target hardware**: Apple M-series MacBook, recent Chrome. Report WASM numbers as well, but WebGPU on M-series is the target.

## How it works (short version)

1. **Extract**: the content script walks the page DOM and collects visible text.
2. **Chunk**: each paragraph is split into sentences, and the sentences are grouped into chunks. Chunk length (default 2 sentences) and overlap (default 0) are settings. Chunks advance by chunk length minus overlap, and the last chunk of a paragraph may be shorter. Each chunk remembers its sentences and where they sit in the DOM. The chunking function is `extension/src/search/chunks.ts`.
3. **Embed**: a small transformer model turns each chunk into a vector (e.g. 384 numbers). Texts with similar meaning get vectors that point in similar directions.
4. **Query**: the user's query is embedded the same way.
5. **Rank**: cosine similarity between the query vector and every chunk vector. Highest scores win.
6. **Hybrid**: combine the semantic score with a fuzzy string score (edit distance) so exact words and typos still rank well. Semantic models alone are weak on single-word typo matching.
7. **Show**: highlight the top matches and scroll to the best one.

Models run via Transformers.js (ONNX Runtime Web), using WebGPU when available and WASM as fallback. Half-precision (fp16) weights are used, because they run on both.

## Tasks

### 1. Understand the model
- Write `docs/how-it-works.md`: embeddings, cosine similarity, chunking trade-offs, why hybrid search, quantization.
- Small Node or notebook demo that embeds a few sentences and prints the similarity matrix, to build intuition.

### 2. Extension demo (MVP)
- Manifest V3 extension, loadable unpacked.
- Shortcut (Cmd+Shift+K, since Chrome reserves Cmd+F, and Cmd+Shift+F and Cmd+Shift+J are blocked) opens a search overlay on the current page.
- Fuzzy-only search first, then add semantic ranking.
- Highlight matches, Enter and Shift+Enter to cycle, Esc to close.
- Semantic search only, no mode switch. The settings panel with sliders (see Decisions).

### 3. Pick 3 models for the first batch
| Model | Why | Approx. size (q8) |
|---|---|---|
| `Xenova/all-MiniLM-L6-v2` | Classic fast baseline, 384 dims | ~23 MB |
| `Xenova/bge-small-en-v1.5` | Stronger English retrieval at similar size | ~34 MB |
| `Xenova/gte-small` | Strong English retrieval, 384 dims, no prefixes needed | ~34 MB |

Plus a **no-model baseline** (fuzzy only) to prove the model earns its cost.
Note: bge works best with its query instruction prefix. MiniLM and gte need none. Check each model card. The q8 sizes are for comparison only. The extension ships fp16 weights, which are about twice as large.

### 4. Test cases and automated benchmark
- Collect 15 to 20 saved English HTML pages: docs, news, Wikipedia, long-form articles.
- Page size scenarios for speed tests: about 1,000, 5,000, 10,000 and 20,000 words.
- For each page, write queries with a labelled correct passage, in five categories:
  - `exact`: the literal word
  - `typo`: misspelled ("optmization")
  - `variant`: different spelling or form ("optimise" vs "optimization")
  - `synonym`: different word, same meaning ("cost" for "price")
  - `paraphrase`: describes the content ("how to cancel my subscription")
- Store as JSON in `bench/cases/`.
- Label the answer as a text span (character offsets in the extracted text), not a chunk id, so labels survive chunking changes.
- What counts as a hit is itself tested: compare "result overlaps the answer span", "result contains the full span" and "result starts within N characters". Pick the rule that best matches what users accept.
- Include hard queries with no word overlap with the answer, otherwise fuzzy search looks better than it is.
- Calibrate the score threshold per model: pick the value that best separates correct from wrong top results (for example best F1), and report it.
- Metrics per model and per category: Recall@1, Recall@5, MRR.
- Speed metrics: model load time (cold and cached), page indexing time, query latency, memory, download size.
- Run in real Chrome via Playwright so numbers reflect WebGPU and WASM as users experience them.
- Output a results table and charts to `bench/results/`.

### 5. Measure time and performance with users
- In-extension logging (local only, opt-in): time from opening search to clicking a result, number of query rewrites, whether a result was accepted.
- Small user study: participants get find tasks on test pages, half with Cmd+F, half with the extension. Compare time-to-find and success rate.
- Export logs as CSV for analysis.

## Run the extension in Chrome

Build once (needs Node 22 and network access to huggingface.co for the model download):

```
cd extension
npm install
npm run fetch-model
npm run build
```

Load it:

1. Open `chrome://extensions`.
2. Turn on "Developer mode" (top right).
3. Click "Load unpacked" and pick the `extension/dist` folder.

Use it:

- Open any normal web page and press Cmd+Shift+K, or click the extension icon in the toolbar. It does not run on `chrome://` pages, the Chrome Web Store or the PDF viewer.
- Type a query. Semantic search runs as you type. The status line shows "Indexing…" or "Searching…" until the result is there.
- Enter and Shift+Enter move between results. Esc closes.
- The Settings button in the overlay opens the settings panel with sliders, raw scores and timings.
- If the shortcut does nothing, check `chrome://extensions/shortcuts`. Another extension may hold the same keys. Chrome only applies a changed default shortcut on a fresh install, so after changing it in the manifest either set it there by hand or remove the extension and load it again.

After a code change, run `npm run build` again, click the reload icon on the extension card in `chrome://extensions`, and reload the page.

Tests: `npm run typecheck`, `npm test` (Node unit tests for chunking and the index cache) and `npm run smoke` (run `npx playwright install chromium` once before the smoke test).

## Proposed repo structure

```
SuperF/              # repo root
  CLAUDE.md
  README.md
  docs/
    how-it-works.md
  extension/
    manifest.json
    src/
      content/        # DOM extraction, chunking, highlighting, overlay UI
      offscreen/      # model loading and embedding
      background/     # service worker, shortcut handling, messaging
      search/         # fuzzy scoring, cosine ranking, hybrid merge
    models/           # bundled model weights
  bench/
    pages/            # saved HTML test pages
    cases/            # JSON query sets with labelled answers
    runner/           # Playwright harness
    results/
  study/
    tasks/            # user study task sheets
    analysis/         # log analysis scripts
```

## Permissions (minimal by design)

- `activeTab`: only the tab where the user triggers search
- `scripting`: inject the content script on demand
- `storage`: settings and cached embeddings
- `offscreen`: run the model outside the page
- `content_security_policy.extension_pages`: include `'wasm-unsafe-eval'`
- No `<all_urls>` host permission in v1. Revisit only if pre-indexing on page load proves necessary.
- No host permission for model download, because weights are bundled.
- One offscreen document serves all tabs (decided). It loads the model once and answers requests tagged with the tab id.

## Milestones

1. Repo scaffold, `how-it-works.md`, embedding playground script
2. Extension skeleton: shortcut, overlay, text extraction, fuzzy search, highlighting
3. Semantic search with one model (MiniLM) in an offscreen document
4. Hybrid ranking (fuzzy plus semantic), tune weights
5. Benchmark harness with test pages and query sets
6. Run benchmark on all 3 models plus baseline, pick a default
7. Opt-in timing logs and user study
8. Polish: settings page, model picker, caching embeddings per URL

## Tech stack

- TypeScript, esbuild for building the extension
- Transformers.js for inference
- Fuse.js or a small custom Damerau-Levenshtein for fuzzy scoring
- Playwright for benchmarks
- Python or TypeScript for result analysis

## Open questions

- Chunk size and overlap: both can now be tried in the settings panel on a real page. Which values become the default is open until the benchmark can measure them (Task 4).
- How to weight fuzzy vs semantic scores (fixed, or by query length)
- What happens to an in-flight semantic query when the user keeps typing (cancel or drop stale results)?
- Handling dynamic pages (infinite scroll, SPAs): re-index on DOM changes?

## Working conventions for Claude Code

- Keep the extension fully offline after model download. Never send page content anywhere.
- Prefer small, testable modules. The search logic in `extension/src/search/` must run in both the extension and the benchmark harness.
- Every new ranking change gets re-run through the benchmark before merging.
- Keep explanations brief. Avoid em dashes and semicolons in docs.
