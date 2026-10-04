// Unit tests for the index cache helpers. Run with "npm test".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lruGet, lruSet, textSignature } from '../src/search/lru.ts';

test('the least recently used key is dropped beyond the cap', () => {
  const map = new Map();
  for (const k of ['a', 'b', 'c']) lruSet(map, k, k.toUpperCase(), 2);
  assert.deepEqual([...map.keys()], ['b', 'c']);
});

test('reading a key keeps it from being dropped', () => {
  const map = new Map();
  lruSet(map, 'a', 1, 2);
  lruSet(map, 'b', 2, 2);
  assert.equal(lruGet(map, 'a'), 1);
  lruSet(map, 'c', 3, 2);
  assert.deepEqual([...map.keys()], ['a', 'c']);
  assert.equal(lruGet(map, 'b'), undefined);
});

test('writing an existing key replaces it without dropping another', () => {
  const map = new Map();
  lruSet(map, 'a', 1, 2);
  lruSet(map, 'b', 2, 2);
  lruSet(map, 'a', 9, 2);
  assert.deepEqual([...map.entries()], [['b', 2], ['a', 9]]);
});

test('the page signature changes with the text and with paragraph borders', () => {
  const sig = textSignature(['One two.', 'Three.']);
  assert.equal(textSignature(['One two.', 'Three.']), sig);
  assert.notEqual(textSignature(['One two.', 'Three!']), sig);
  assert.notEqual(textSignature(['One two.', 'Three.', 'Four.']), sig);
  assert.notEqual(textSignature(['One two.Three.']), sig);
  assert.notEqual(textSignature(['One two', '.Three.']), sig);
});
