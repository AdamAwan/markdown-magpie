// Consensus counting for source-map hints (#219). Each time an agent
// independently contributes the same topic → paths mapping — i.e. the new
// hint's paths overlap an existing entry's paths above the agreement threshold
// — the entry's consensus count increments (capped at MAX_CONSENSUS_COUNT). A
// contradicting hint (overlap at or below the threshold) resets it to 1, as
// does a first-seen (source_id, topic). Higher counts mean more independent
// agents agree, so the hint is more trustworthy.
//
// Shared by both the in-memory and Postgres stores so the two backends apply
// exactly the same rule and can never drift.

// Max consensus count, to keep the data model simple.
const MAX_CONSENSUS_COUNT = 5;

// Paths agree when their Jaccard similarity strictly exceeds this threshold.
const AGREEMENT_THRESHOLD = 0.5;

// Jaccard similarity of two path sets: |intersection| / |union|, in [0, 1]
// (1.0 = identical non-empty sets; 0 = disjoint, or both empty).
function jaccardSimilarity(paths1: string[], paths2: string[]): number {
  const set1 = new Set(paths1);
  const set2 = new Set(paths2);
  const intersection = [...set1].filter((p) => set2.has(p)).length;
  const union = new Set([...set1, ...set2]).size;
  return union === 0 ? 0 : intersection / union;
}

// The consensus count an upsert should store, given the count and paths of the
// entry it replaces (or undefined when there is no existing entry).
export function nextConsensusCount(
  newPaths: string[],
  existing: { consensusCount: number; paths: string[] } | undefined
): number {
  if (!existing) {
    return 1;
  }
  if (jaccardSimilarity(newPaths, existing.paths) > AGREEMENT_THRESHOLD) {
    return Math.min(existing.consensusCount + 1, MAX_CONSENSUS_COUNT);
  }
  return 1;
}
