import type { Confidence } from "@magpie/core";

/** A configured flow paired with the embedding of its routing text (name + persona). */
export interface EmbeddedFlow {
  id: string;
  vector: number[];
}

/** Abstain-biased cut-offs for the embedding router (see FLOW_ROUTER_* env). */
export interface EmbeddingRouteOptions {
  // The top flow must clear this cosine floor to be trusted at all.
  minTopScore: number;
  // The top flow must beat the runner-up by at least this much, else the scores are
  // too close to call and the caller falls back to the chat router.
  minMargin: number;
}

/**
 * Outcome of the cheap embedding-similarity router.
 *
 * - `routed` — one flow is a confident winner (clears the score floor and the margin).
 * - `abstain` — no flow is a confident winner (nothing configured, everything below the
 *   floor, or a near-tie). The caller falls back to the chat router; abstaining is always
 *   safe because it only reproduces the pre-existing behaviour.
 *
 * It deliberately never returns `unknown`: only the chat router abstains *to the user*
 * (flow-selection-required), so this router never triggers that path itself.
 */
export type EmbeddingRoute =
  { status: "routed"; flowId: string; confidence: Confidence; margin: number } | { status: "abstain" };

/**
 * Cosine similarity of two equal-length vectors. Returns 0 (rather than NaN) for a zero
 * vector or a length mismatch, so a degenerate embedding abstains rather than routing.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Picks the single best-matching flow for a question by cosine similarity between the
 * question embedding and each flow's embedding. Routes only when the top flow clears the
 * score floor AND beats the runner-up by the margin; otherwise abstains so the caller can
 * fall back to the chat router. Confidence is `high` when the margin is comfortably clear
 * (≥ 2× the threshold), else `medium`.
 */
export function routeByEmbeddingSimilarity(
  questionVector: number[],
  flows: EmbeddedFlow[],
  options: EmbeddingRouteOptions
): EmbeddingRoute {
  if (flows.length === 0) {
    return { status: "abstain" };
  }

  const scored = flows
    .map((flow) => ({ id: flow.id, score: cosineSimilarity(questionVector, flow.vector) }))
    .sort((left, right) => right.score - left.score);

  const top = scored[0];
  if (top.score < options.minTopScore) {
    return { status: "abstain" };
  }

  // A lone flow has no runner-up to beat; treat the runner-up as −∞ so the margin gate
  // passes on the score floor alone. (In practice the watcher short-circuits ≤1 flow
  // before ever calling the router — this only keeps the pure function total.)
  const runnerUp = scored[1]?.score ?? Number.NEGATIVE_INFINITY;
  const margin = top.score - runnerUp;
  if (margin < options.minMargin) {
    return { status: "abstain" };
  }

  const confidence: Confidence = margin >= options.minMargin * 2 ? "high" : "medium";
  return { status: "routed", flowId: top.id, confidence, margin };
}
