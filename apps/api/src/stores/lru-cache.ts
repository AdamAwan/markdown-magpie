// A small bounded least-recently-used cache. Backed by a Map, which preserves
// insertion order, so the oldest live key is always the first one iterated — that
// makes eviction an O(1) `keys().next()` lookup with no auxiliary bookkeeping.
//
// Intentionally minimal: in-memory, synchronous, no TTL. It exists to stop
// byte-identical work (e.g. re-embedding the same query text) from repeating
// within a process, not to be a general-purpose cache. Values must be defined —
// a stored `undefined` is indistinguishable from a miss and is treated as one.
export class LruCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("LruCache capacity must be a positive integer");
    }
  }

  get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) {
      return undefined;
    }
    // Touch: re-insert so this key becomes the most-recently-used (moves to the
    // end of the Map's iteration order).
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    // Delete first so a re-set moves the key to the most-recently-used position
    // rather than updating in place (which would leave its age unchanged).
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
