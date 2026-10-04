# Semantic Find extension

Manifest V3 extension. Cmd+Shift+J opens a search overlay on the current page.

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

- Cmd+Shift+J (or the toolbar icon) opens and closes the overlay.
- `Word` finds exact text like Cmd+F. If nothing matches exactly, it falls back to typo-tolerant word matching.
- `Semantic` ranks passages by meaning, mixed with the fuzzy word score.
- Enter and Shift+Enter move between results, best first. Esc closes.
- Alt+D inside the overlay toggles the dev panel: threshold, weight and sentence sliders, plus raw scores per result.

## Test

```
npx playwright install chromium   # once
npm run build && npm run smoke    # add -- --headed to watch
npm run typecheck
```

## Layout

- `src/search/`: fuzzy scoring, cosine ranking, hybrid merge, sentence splitting. Pure functions, also used by `bench/`.
- `src/content/`: DOM extraction, chunking, highlighting, overlay.
- `src/offscreen/`: loads the model once and keeps chunk vectors per tab.
- `src/background/`: shortcut handling and message relay.
- `src/model.ts`: model id, weight precision and default score threshold.
