import type { ReuseDecision } from "./reuse-check.js";

// Free verbatim reuse is allowed ONLY for the unambiguous case: exactly one
// matched candidate whose cited sources are unchanged AND nothing newer is
// relevant. Any other shape (0 candidates, 2+, or a changed single) goes to the
// grounded reconcile step. See 2026-07-17-questionnaire-trust-design.md §1.2.
export function isFastPathReusable(candidateCount: number, decision: ReuseDecision): boolean {
  return candidateCount === 1 && decision.reuse;
}
