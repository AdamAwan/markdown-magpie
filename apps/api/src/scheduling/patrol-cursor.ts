// Pure rolling-cursor selection: pick the documents a patrol tick should check.
// Oldest-checked first (a never-checked doc counts as oldest) for the exploit
// share, plus a small random sample of the remainder for the explore share — so
// the patrol clears the staleness backlog while no document starves and load
// never synchronises into waves. See docs/maintenance-redesign.md (Decisions).

export interface PatrolBatchOptions {
  batchSize: number;
  randomCount: number;
  rng?: () => number;
}

export function selectPatrolBatch(
  universe: string[],
  checkedAt: Map<string, string>,
  options: PatrolBatchOptions
): string[] {
  const { batchSize, randomCount, rng = Math.random } = options;
  if (batchSize <= 0 || universe.length === 0) {
    return [];
  }
  if (universe.length <= batchSize) {
    return [...universe];
  }

  // Oldest first. An absent entry ("never checked") is the empty string, which
  // sorts before any ISO timestamp; ties (incl. all never-checked) break by path,
  // so the order is fully deterministic.
  const byStaleness = [...universe].sort((a, b) => {
    const ca = checkedAt.get(a) ?? "";
    const cb = checkedAt.get(b) ?? "";
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const exploitCount = Math.max(0, Math.min(batchSize - randomCount, byStaleness.length));
  const exploit = byStaleness.slice(0, exploitCount);

  const remainder = byStaleness.slice(exploitCount);
  const exploreCount = Math.min(randomCount, remainder.length, batchSize - exploit.length);
  const explore = sampleWithoutReplacement(remainder, exploreCount, rng);

  return [...exploit, ...explore];
}

function sampleWithoutReplacement<T>(items: T[], count: number, rng: () => number): T[] {
  if (count <= 0) {
    return [];
  }
  const pool = [...items];
  const out: T[] = [];
  for (let i = 0; i < count && pool.length > 0; i += 1) {
    const index = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
    out.push(pool.splice(index, 1)[0]!);
  }
  return out;
}
