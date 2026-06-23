// The maintenance lenses, each a distinct reason a knowledge-base change is
// warranted. Event-driven lenses (gap, source-sync) fire when the world changes;
// patrol lenses (verify, dedupe, split, complete) fire on a rolling cursor. Every
// lens emits a ChangeIntent rather than a PR directly; the reconcile gate decides
// whether that intent opens a new PR or folds into an open one. See
// docs/maintenance-redesign.md.
export const MAINTENANCE_LENSES = [
  "gap",
  "source-sync",
  "verify",
  "dedupe",
  "split",
  "complete"
] as const;

export type MaintenanceLens = (typeof MAINTENANCE_LENSES)[number];

// A proposed knowledge-base change, before it becomes a PR. `targets` are the doc
// paths the change would write to or delete; it is empty when the target file is
// not yet known (a gap whose file the draft job decides later — see the plan's
// Global Constraints).
export interface ChangeIntent {
  lens: MaintenanceLens;
  flowId?: string;
  targets: string[];
  evidence: string[];
  rationale: string;
}
