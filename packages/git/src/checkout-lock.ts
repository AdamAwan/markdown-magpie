// An in-process mutex keyed by checkout path. All mutating git against a given
// checkout (clone/fetch/reset in ensureGitCheckout, worktree add/push in the
// publisher) runs through here, so concurrent operations on the same working tree
// serialize instead of racing on shared `.git` state (FETCH_HEAD, index.lock, refs).
// Calls with different keys are unaffected and run concurrently.
//
// Scope is one process: with the api and watcher on separate checkout volumes this
// fully serializes each process's access to its own checkouts. Cross-process /
// multi-replica serialization is out of scope (would need a file or advisory lock).
const tails = new Map<string, Promise<unknown>>();

export function withCheckoutLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  // Run once the previous holder settles, regardless of how it settled — a
  // rejecting holder must not prevent the next caller from acquiring the lock.
  const run = previous.then(fn, fn);
  // The stored tail never rejects, so the chain stays alive after a failure.
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  tails.set(key, tail);
  // Drop the entry once the chain fully drains, so the map doesn't accumulate
  // settled promises for checkouts that are no longer in flight.
  void tail.then(() => {
    if (tails.get(key) === tail) {
      tails.delete(key);
    }
  });
  return run;
}
