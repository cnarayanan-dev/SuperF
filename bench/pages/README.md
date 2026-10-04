# Benchmark test pages

Saved English HTML pages for task 4. They cover Wikipedia, news, university sites (UZH, ETH), docs, government pages and long-form text.

## Files

- `sources.json`: the list of pages (id, type, url, license, commit flag). Edit this to add or swap pages.
- `fetch.mjs`: downloads the pages and writes `pages.json`.
- `pages.json`: generated lock file with word count, size bucket, fetch date and SHA-256 per page.
- `html/`: openly licensed pages. Checked in.
- `local/`: copyrighted pages (BBC, Guardian, UZH and so on). Gitignored. Each developer fetches them locally.

## Usage

```bash
node fetch.mjs            # fetch missing pages, keep existing ones
node fetch.mjs --force    # refetch everything
node fetch.mjs uzh-home   # only some ids
```

Existing files are never overwritten without `--force`, so answer labels in `bench/cases/` stay valid. If a file no longer matches its SHA-256 in `pages.json`, the script prints `CHANGED`.

## Notes

- Pages in `local/` are live pages. A fresh fetch on another machine can differ from the copy the labels were written against. Check the `CHANGED` warning before trusting results on those pages.
- News URLs can expire. Replace a dead one in `sources.json` with a similar article.
- Word counts come from a rough tag strip and include navigation text. They only sort pages into size buckets (1k, 5k, 10k, 20k). The real extractor will report lower numbers.
- The HTML is the raw server response. Pages still reference remote CSS and scripts, so the benchmark runner should block network requests.
- Wikipedia text is CC BY-SA 4.0. Keep the license column in `sources.json` up to date when adding pages.
