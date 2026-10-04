# Semantic Find extension

Manifest V3 extension. Cmd+Shift+K opens a search overlay on the current page.

## Build and load

```
cd extension
npm install
npm run fetch-model   # downloads MiniLM (fp16, 45 MB) from huggingface.co into models/
npm run build         # writes dist/
```

Then open `chrome://extensions`, turn on Developer mode, choose "Load unpacked" and pick `extension/dist`.

The model is fetched once at build time and bundled. The extension itself never goes online.

## Use

- Cmd+Shift+K (or the toolbar icon) opens and closes the overlay.
- Type a query. Passages are ranked by meaning, mixed with the fuzzy word score, so typos still match.
- For exact matching use the browser's own Cmd+F.
- Enter and Shift+Enter move between results, best first. Esc closes.
- The Settings button opens the settings panel: threshold, weight, chunk length and overlap sliders, raw scores per result, chunk count and timings. Reset restores the defaults.

## Test

```
npx playwright install chromium   # once
npm run build && npm run smoke    # add -- --headed to watch
npm run typecheck
npm test                          # Node unit tests for chunking
```

## Layout

- `src/search/`: fuzzy scoring, cosine ranking, hybrid merge, sentence splitting, chunking. Pure functions, also used by `bench/`.
- `src/content/`: DOM extraction, highlighting, overlay and settings panel.
- `src/offscreen/`: loads the model once and keeps chunk vectors per tab.
- `src/background/`: shortcut handling and message relay.
- `src/model.ts`: model id, weight precision and default score threshold.
