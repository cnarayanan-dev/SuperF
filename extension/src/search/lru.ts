// A Map used as a least-recently-used cache. Maps iterate in insertion order,
// so the first key is the one that was used longest ago.

// The number of indexes kept per tab, one per configuration and page text.
export const MAX_INDEXES = 4;

// Reads a key and makes it the most recently used.
export function lruGet<K, V>(map: Map<K, V>, key: K): V | undefined {
  const value = map.get(key);
  if (value === undefined) return undefined;
  map.delete(key);
  map.set(key, value);
  return value;
}

// Writes a key as the most recently used and drops the least recently used beyond max.
export function lruSet<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as K);
}

// Signature of the page text (FNV-1a hash plus length). A change to any paragraph changes it.
export function textSignature(texts: string[]): string {
  let hash = 0x811c9dc5, length = 0;
  for (const text of texts) {
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
    hash = Math.imul(hash ^ 0xffff, 0x01000193); // paragraph border
    length += text.length;
  }
  return `${texts.length}:${length}:${(hash >>> 0).toString(36)}`;
}
