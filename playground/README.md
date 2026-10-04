# Embedding playground

Embeds 8 sentences and prints a cosine similarity matrix. Used to build intuition for `docs/how-it-works.md`.

## Run

```
cd playground
npm install
node embed.mjs
node embed.mjs --model Xenova/bge-small-en-v1.5
node embed.mjs --model Xenova/multilingual-e5-small
node embed.mjs --dtype fp32
```

Options:
- `--model <id>`: any Transformers.js feature-extraction model (default `Xenova/all-MiniLM-L6-v2`)
- `--dtype <q8|q4|fp32>`: weight precision (default `q8`)

The first run downloads the model from huggingface.co and caches it. It needs network access to that host.
Models with `e5` in the id automatically get the `query: ` prefix.

## Sentences

| # | Role | Text |
|---|---|---|
| 0 | base | The cat sat on the sofa. |
| 1 | typo pair with 0 | The cat sat on the sofaa and slept. |
| 2, 3 | synonym pair | subscription cost / price of the monthly plan |
| 4, 5 | paraphrase pair | cancel my membership / end my subscription |
| 6 | unrelated | The stock market fell sharply on Monday. |
| 7 | German | Die Katze sass auf dem Sofa. |
