import type { ReuseDecision } from "./reuse-check.js";

// Two directions are the same steer only if their text is identical after
// trimming. Absent, empty and all-whitespace all normalise to "no direction",
// so a questionnaire without a direction still reuses freely from other
// undirected ones — i.e. exactly the behaviour before directions existed.
// Deliberately exact: guessing that two differently-worded directions mean the
// same thing is the failure mode this feature exists to remove, and a mismatch
// is cheap — it falls through to the grounded reconcile step, not to a fresh
// answer. See 2026-07-31-questionnaire-direction-design.md part 3.
export function directionsMatch(a: string | undefined, b: string | undefined): boolean {
  return (a?.trim() ?? "") === (b?.trim() ?? "");
}

// Free verbatim reuse is allowed ONLY for the unambiguous case: exactly one
// matched candidate whose cited sources are unchanged, nothing newer is
// relevant, AND the candidate was answered under the same direction — a
// candidate written under a different steer may answer a different READING of
// the question, which only the reconcile step can judge. Any other shape (0
// candidates, 2+, a changed single, a direction mismatch) goes to the grounded
// reconcile step. See 2026-07-17-questionnaire-trust-design.md §1.2.
export function isFastPathReusable(
  candidateCount: number,
  decision: ReuseDecision,
  directionMatches: boolean
): boolean {
  return candidateCount === 1 && decision.reuse && directionMatches;
}
