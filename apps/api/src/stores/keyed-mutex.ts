// Serializes async work per key within this process: `run(key, fn)` starts `fn`
// only after every earlier `run` for the same key has settled (fulfilled or
// rejected), while different keys proceed in parallel. A failed run never wedges
// the key — the next waiter starts regardless. Entries are dropped once a key's
// queue drains, so the map holds only keys with work in flight.
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(fn);
    // The next waiter chains on this run's settlement, never its outcome.
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}
