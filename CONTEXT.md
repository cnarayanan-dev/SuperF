# Semantic Find

A Chrome extension for finding a passage on the current page by meaning. It complements the browser's built-in find and does not replace it.

## Language

**Cmd+F**:
The browser's built-in find, which matches the literal characters typed. It is the fallback for exact matching and is not part of the extension.
_Avoid_: Word mode, exact mode, native search

**Semantic search**:
The only kind of search the overlay offers. It finds passages by meaning, and ranks them by a blend of the semantic score and the fuzzy score.
_Avoid_: Semantic mode, smart search, hybrid search

**Settings panel**:
The part of the overlay, opened by its Settings button, where the search configuration is changed while searching.
_Avoid_: Dev panel, tuning panel, options page

**Chunk**:
A run of consecutive sentences from the page that is scored as one unit. Every result is a chunk.
_Avoid_: Passage, segment, block

**Chunk length**:
The number of sentences in a chunk.
_Avoid_: Configuration length, window size

**Overlap**:
The number of sentences that two neighbouring chunks share.
_Avoid_: Stride, sliding window

**Highlight**:
The part of a result's chunk that is marked on the page. It can be shorter than the chunk.
_Avoid_: Match, selection

**Highlight length**:
The number of sentences in a highlight.

**Semantic score**:
How close a passage is to the query in meaning, as judged by the embedding model.
_Avoid_: Cosine, similarity, model score

**Fuzzy score**:
How well the words of a passage match the words of the query, allowing for typos. It is an ingredient of the ranking and never a search of its own.
_Avoid_: Word score, exact score

**Semantic weight**:
The share of the ranking that comes from the semantic score. The rest comes from the fuzzy score.
_Avoid_: Hybrid weight, fuzzy weight

**Overlay**:
The search box the extension shows on top of the page.
_Avoid_: Popup, search bar, panel
