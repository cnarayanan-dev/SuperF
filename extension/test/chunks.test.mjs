// Unit tests for chunking. Run with "npm test" (Node built-in test runner).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestWindow, chunkRanges, chunkSentences, clampOverlap } from '../src/search/chunks.ts';

// A paragraph of n sentences, each 10 characters long.
const paragraph = (n) => Array.from({ length: n }, (_, i) => [i * 10, i * 10 + 9]);
// Chunks as sentence numbers per chunk, like "0,1 2,3", with the paragraph in front when asked.
const shape = (chunks) => chunks.map((c) => c.map((s) => s.start / 10).join(',')).join(' ');

test('chunk length without overlap', () => {
  assert.equal(shape(chunkSentences([paragraph(6)], 2, 0)), '0,1 2,3 4,5');
  assert.equal(shape(chunkSentences([paragraph(6)], 3, 0)), '0,1,2 3,4,5');
  assert.equal(shape(chunkSentences([paragraph(3)], 1, 0)), '0 1 2');
});

test('chunks advance by chunk length minus overlap', () => {
  assert.equal(shape(chunkSentences([paragraph(5)], 3, 1)), '0,1,2 2,3,4');
  assert.equal(shape(chunkSentences([paragraph(4)], 2, 1)), '0,1 1,2 2,3');
});

test('the last chunk may be shorter than the chunk length', () => {
  assert.equal(shape(chunkSentences([paragraph(5)], 2, 0)), '0,1 2,3 4');
  assert.equal(shape(chunkSentences([paragraph(6)], 3, 1)), '0,1,2 2,3,4 4,5');
});

test('no trailing chunk that only repeats earlier sentences', () => {
  // Without the rule, 4 sentences with length 3 and overlap 2 would end with "2,3" and "3".
  assert.equal(shape(chunkSentences([paragraph(4)], 3, 2)), '0,1,2 1,2,3');
  assert.equal(shape(chunkSentences([paragraph(3)], 3, 1)), '0,1,2');
});

test('a paragraph shorter than the chunk length is one chunk', () => {
  assert.equal(shape(chunkSentences([paragraph(2)], 4, 0)), '0,1');
  assert.equal(shape(chunkSentences([paragraph(1)], 6, 2)), '0');
  assert.deepEqual(chunkSentences([[]], 2, 0), []);
});

test('a chunk never leaves its paragraph', () => {
  const chunks = chunkSentences([paragraph(3), paragraph(1), paragraph(2)], 2, 0);
  assert.equal(shape(chunks), '0,1 2 0 0,1');
  assert.deepEqual(chunks.map((c) => c[0].paragraph), [0, 0, 1, 2]);
  assert.ok(chunks.every((c) => c.every((s) => s.paragraph === c[0].paragraph)));
});

test('overlap is clamped below the chunk length', () => {
  assert.equal(clampOverlap(1, 2), 0);
  assert.equal(clampOverlap(2, 2), 1);
  assert.equal(clampOverlap(3, 2), 2);
  assert.equal(clampOverlap(4, -1), 0);
  assert.equal(shape(chunkSentences([paragraph(3)], 1, 2)), '0 1 2');
  assert.equal(shape(chunkSentences([paragraph(4)], 2, 2)), '0,1 1,2 2,3');
  // A chunk length below 1 must not loop forever.
  assert.equal(shape(chunkSentences([paragraph(2)], 0, 0)), '0 1');
});

test('a chunk is drawn as one range per paragraph', () => {
  const [chunk] = chunkSentences([paragraph(3)], 3, 0);
  assert.deepEqual(chunkRanges(chunk), [[0, 0, 29]]);
  const crossing = [{ paragraph: 0, start: 20, end: 29 }, { paragraph: 1, start: 0, end: 9 }, { paragraph: 1, start: 10, end: 19 }];
  assert.deepEqual(chunkRanges(crossing), [[0, 20, 29], [1, 0, 19]]);
});

// With crossing on, each sentence is shown as paragraph.sentence, like "0.2,1.0".
const crossShape = (chunks) => chunks.map((c) => c.map((s) => `${s.paragraph}.${s.start / 10}`).join(',')).join(' ');

test('with crossing on, a chunk can cover several paragraphs', () => {
  assert.equal(crossShape(chunkSentences([paragraph(3), paragraph(2)], 2, 0, true)), '0.0,0.1 0.2,1.0 1.1');
  assert.equal(crossShape(chunkSentences([paragraph(1), paragraph(1), paragraph(2)], 4, 0, true)), '0.0,1.0,2.0,2.1');
  assert.equal(crossShape(chunkSentences([paragraph(2), [], paragraph(3)], 3, 1, true)), '0.0,0.1,2.0 2.0,2.1,2.2');
  const [chunk] = chunkSentences([paragraph(1), paragraph(2)], 3, 0, true);
  assert.deepEqual(chunkRanges(chunk), [[0, 0, 9], [1, 0, 19]]);
});

test('crossing is off unless asked for', () => {
  const paragraphs = [paragraph(1), paragraph(1), paragraph(2)];
  assert.deepEqual(chunkSentences(paragraphs, 4, 0), chunkSentences(paragraphs, 4, 0, false));
  assert.equal(crossShape(chunkSentences(paragraphs, 4, 0, false)), '0.0 1.0 2.0,2.1');
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
