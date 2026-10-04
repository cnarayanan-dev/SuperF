# Semantic Find: smarter in-page search for Chrome

## Goal

Build a Chrome extension that improves Cmd+F. It finds the word or passage a user is looking for even when the query has typos, uses a different spelling, or describes the meaning instead of the exact words. Everything runs locally in the browser with a small embedding model. No server, no data leaves the machine.

Success means:
- Finds the right passage for typo, synonym and paraphrase queries where Cmd+F fails
- Indexes a typical article page in under 1 second
- Answers a query in under 100 ms after indexing
- Users find things faster than with Cmd+F (measured, not assumed)

## How it works (short version)

1. **Extract**: the content script walks the page DOM and collects visible text.
2. **Chunk**: text is split into small pieces (sentences or short paragraphs, roughly 30 to 100 words, with slight overlap). Each chunk remembers which DOM node it came from.
3. **Embed**: a small transformer model turns each chunk into a vector (e.g. 384 numbers). Texts with similar meaning get vectors that point in similar directions.
4. **Query**: the user's query is embedded the same way.
5. **Rank**: cosine similarity between the query vector and every chunk vector. Highest scores win.
6. **Hybrid**: combine the semantic score with a fuzzy string score (edit distance) so exact words and typos still rank well. Semantic models alone are weak on single-word typo matching.
7. **Show**: highlight the top matches and scroll to the best one.

Models run via Transformers.js (ONNX Runtime Web), using WebGPU when available and WASM as fallback. Quantized (q8) weights keep downloads small.

## Tasks

### 1. Understand the model
- Write `docs/how-it-works.md`: embeddings, cosine similarity, chunking trade-offs, why hybrid search, quantization.
- Small Node or notebook demo that embeds a few sentences and prints the similarity matrix, to build intuition.

### 2. Extension demo (MVP)
- Manifest V3 extension, loadable unpacked.
- Shortcut (Cmd+Shift+F, since Chrome reserves Cmd+F) opens a search overlay on the current page.
- Fuzzy-only search first, then add semantic ranking.
- Highlight matches, Enter and Shift+Enter to cycle, Esc to close.

### 3. Pick 3 models for the first batch
| Model | Why | Approx. size (q8) |
|---|---|---|
| `Xenova/all-MiniLM-L6-v2` | Classic fast baseline, 384 dims | ~23 MB |
| `Xenova/bge-small-en-v1.5` | Stronger English retrieval at similar size | ~34 MB |
| `Xenova/multilingual-e5-small` | Covers German and other languages | ~118 MB |

Plus a **no-model baseline** (fuzzy only) to prove the model earns its cost.
Note: e5 models need `query: ` and `passage: ` prefixes. bge works best with its query instruction prefix. Check each model card.

### 4. Test cases and automated benchmark
- Collect 15 to 20 saved HTML pages: docs, news, Wikipedia, long-form articles, a few German pages.
- For each page, write queries with a labelled correct passage, in five categories:
  - `exact`: the literal word
  - `typo`: misspelled ("optmization")
  - `variant`: different spelling or form ("optimise" vs "optimization")
  - `synonym`: different word, same meaning ("cost" for "price")
  - `paraphrase`: describes the content ("how to cancel my subscription")
- Store as JSON in `bench/cases/`.
- Metrics per model and per category: Recall@1, Recall@5, MRR.
- Speed metrics: model load time (cold and cached), page indexing time, query latency, memory, download size.
- Run in real Chrome via Playwright so numbers reflect WebGPU and WASM as users experience them.
- Output a results table and charts to `bench/results/`.

### 5. Measure time and performance with users
- In-extension logging (local only, opt-in): time from opening search to clicking a result, number of query rewrites, whether a result was accepted.
- Small user study: participants get find tasks on test pages, half with Cmd+F, half with the extension. Compare time-to-find and success rate.
- Export logs as CSV for analysis.

## Proposed repo structure

```
semantic-find/
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
    models/           # optional bundled weights
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

- TypeScript, Vite (or similar) for building the extension
- Transformers.js for inference
- Fuse.js or a small custom Damerau-Levenshtein for fuzzy scoring
- Playwright for benchmarks
- Python or TypeScript for result analysis

## Open questions

- Bundle model weights or download on first use and cache?
- Chunk size and overlap: test 1 sentence vs 2 to 3 sentences
- How to weight fuzzy vs semantic scores (fixed, or by query length)
- Should German support be a v1 requirement? If yes, multilingual-e5-small becomes the likely default
- Handling dynamic pages (infinite scroll, SPAs): re-index on DOM changes?

## Working conventions for Claude Code

- Keep the extension fully offline after model download. Never send page content anywhere.
- Prefer small, testable modules. The search logic in `extension/src/search/` must run in both the extension and the benchmark harness.
- Every new ranking change gets re-run through the benchmark before merging.
- Keep explanations brief. Avoid em dashes and semicolons in docs.
