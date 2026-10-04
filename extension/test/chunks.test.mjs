// Unit tests for the chunking function. Run with "npm test".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestWindow, chunkSentences, chunkText, clampOverlap, toRanges } from '../src/search/chunks.ts';
import { splitSentences } from '../src/search/sentences.ts';

// Paragraphs are written one letter per sentence: 'A B C' is the text "A. B. C." with three sentences.
const page = (...paragraphs) => {
  const names = paragraphs.map((p) => p.split(' ').filter(Boolean));
  return {
    texts: names.map((p) => p.map((w) => `${w}.`).join(' ')),
    sentences: names.map((p) => p.map((_, i) => [i * 3, i * 3 + 2])),
  };
};
// Chunks as readable strings, with " | " where a chunk moves on to the next paragraph.
const chunked = (paragraphs, ...config) => {
  const { texts, sentences } = page(...paragraphs);
  return chunkSentences(sentences, ...config).map((c) => toRanges(c).map((r) => texts[r.para].slice(r.start, r.end)).join(' | '));
};

test('chunk length without overlap', () => {
  assert.deepEqual(chunked(['A B C D'], 2, 0), ['A. B.', 'C. D.']);
  assert.deepEqual(chunked(['A B C'], 1, 0), ['A.', 'B.', 'C.']);
});

test('chunks advance by chunk length minus overlap', () => {
  assert.deepEqual(chunked(['A B C D E'], 3, 1), ['A. B. C.', 'C. D. E.']);
  assert.deepEqual(chunked(['A B C D E F G'], 3, 2), ['A. B. C.', 'B. C. D.', 'C. D. E.', 'D. E. F.', 'E. F. G.']);
});

test('the last chunk may be shorter than chunk length', () => {
  assert.deepEqual(chunked(['A B C D E'], 2, 0), ['A. B.', 'C. D.', 'E.']);
  assert.deepEqual(chunked(['A B C D E F'], 4, 1), ['A. B. C. D.', 'D. E. F.']);
});

test('no trailing chunk that only repeats sentences of the chunk before it', () => {
  assert.deepEqual(chunked(['A B C D'], 2, 1), ['A. B.', 'B. C.', 'C. D.']);
  assert.deepEqual(chunked(['A B C D'], 3, 2), ['A. B. C.', 'B. C. D.']);
});

test('a paragraph shorter than chunk length is one chunk', () => {
  assert.deepEqual(chunked(['A B', 'C'], 4, 2), ['A. B.', 'C.']);
});

test('a chunk never leaves its paragraph', () => {
  assert.deepEqual(chunked(['A B C', 'D E'], 2, 0), ['A. B.', 'C.', 'D. E.']);
  assert.deepEqual(chunked(['A', '', 'B'], 2, 0), ['A.', 'B.']);
});

test('overlap is clamped below chunk length', () => {
  assert.equal(clampOverlap(2, 2), 1);
  assert.equal(clampOverlap(1, 2), 0);
  assert.equal(clampOverlap(4, 2), 2);
  assert.deepEqual(chunked(['A B C'], 2, 5), chunked(['A B C'], 2, 1));
  assert.deepEqual(chunked(['A B C'], 1, 1), ['A.', 'B.', 'C.']);
});

test('the chunk text joins the sentences with a space', () => {
  const texts = ['One.\n\n  Two.   Three.'];
  const [chunk] = chunkSentences(texts.map(splitSentences), 3, 0);
  assert.equal(chunkText(texts, chunk), 'One. Two. Three.');
});

test('the highlight is the run of sentences with the highest summed score', () => {
  assert.deepEqual(bestWindow([0.1, 0.5, 0.4, 0.2], 2), [1, 3]);
  assert.deepEqual(bestWindow([0.1, 0.5, 0.4, 0.9], 1), [3, 4]);
  assert.deepEqual(bestWindow([0.9, 0.1, 0.1, 0.8, 0.3], 3), [2, 5]);
  assert.deepEqual(bestWindow([-0.2, -0.1, -0.3], 2), [0, 2]);
});

test('a chunk no longer than the highlight length is highlighted whole', () => {
  assert.deepEqual(bestWindow([0.1, 0.9], 2), [0, 2]);
  assert.deepEqual(bestWindow([0.1, 0.9], 3), [0, 2]);
});

test('the first run wins a tie', () => {
  assert.deepEqual(bestWindow([0.5, 0.5, 0.5], 2), [0, 2]);
});
