export const DEFAULT_RRF_K = 60;

/**
 * Reciprocal Rank Fusion. Each input is a list of ids ordered best-first.
 * An id's fused score is the sum of 1 / (k + rank) across the lists it appears
 * in (rank is 1-based). Rank-based, so it needs no score normalisation between
 * the vector and keyword lists.
 */
export function fuseRankings(rankings: string[][], k: number = DEFAULT_RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return scores;
}
