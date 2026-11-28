import type {
  DetectedSourceConflict,
  ResolvedSourceConflict,
  SourceDescriptor,
  UnprovableClaim,
  VerifyDocumentJobInput,
  VerifyDocumentJobOutput,
  VerifyFinding
} from "@magpie/core";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";
import type { ChangeIntent } from "./intent.js";
import { decideReconciliation, openPullRequestSummaries, type OpenPullRequestSummary } from "./reconcile-gate.js";
import { sameFlowOpenProposals } from "./flow.js";

// A verify that was ENQUEUED rather than answered: the verify_document job now
// queued or running. Its verdict arrives later, at the job's completion, and is
// applied there (the patrol's continuation) — the lens never waits for it.
interface VerifyPending {
  pendingJobId: string;
}

// Starts the verify check for one document. The default implementation (in the
// patrol service) enqueues a verify_document AI job and returns `VerifyPending`
// at once; a deterministic fake (tests) may return the verdict directly, which
// the lens then folds in immediately. Returns undefined when no verify could be
// started (fan-out shed, enqueue failure) so the lens simply skips that doc.
export type VerifyDocumentFn = (
  ctx: AppContext,
  input: VerifyDocumentJobInput & { flowId: string | undefined }
) => Promise<VerifyDocumentJobOutput | VerifyPending | undefined>;

// Builds the verify lens's change intent for the reconcile gate. decideReconciliation
// consumes only `targets`; evidence/rationale are populated for logging and the
// future corrective-PR increment.
export function verifyIntent(flowId: string | undefined, path: string, claims: UnprovableClaim[]): ChangeIntent {
  return {
    lens: "verify",
    flowId,
    targets: [path],
    evidence: claims.map((claim) => claim.claim),
    rationale: `verify: ${claims.length} unprovable claim(s) in ${path}`
  };
}

// Runs the verify lens over the selected documents: check each against the flow's
// configured sources (carried as `sources` descriptors — the executing agent
// explores those checkouts directly, per job), and for every "unprovable" verdict
// emit a verify intent through
// the reconcile gate (same-flow open PRs only) and record a finding. Healthy docs
// are silent. A per-doc failure is logged and skipped — one bad doc never aborts
// the tick.
//
// Returns the findings plus `checkedPaths`: the documents that yielded a real
// verdict (healthy or not) this tick. A doc whose verify threw, returned nothing,
// or is still `pending` is NOT in checkedPaths — so the caller's change gate never
// records a "verified" hash for a doc it did not actually verify, which would
// otherwise suppress it forever after a transient provider outage (#163).
export interface VerifyLensResult {
  findings: VerifyFinding[];
  checkedPaths: string[];
  // Disagreements between the SOURCES, carried out of the lens untouched by the
  // reconcile gate. They are not document defects: no corrective proposal can
  // resolve one without picking a winner between two sources, so they route to
  // the conflict register and the document is annotated instead.
  conflicts: Array<DetectedSourceConflict & { path: string }>;
  // Known conflicts the agent reported the sources now agree on.
  resolved: Array<ResolvedSourceConflict & { path: string }>;
  // Documents whose verify was enqueued and has not answered. Each one's verdict
  // is folded in by the job's completion (foldVerdict below), not by this lens.
  pending: Array<{ path: string; jobId: string }>;
}

export function emptyVerifyLensResult(): VerifyLensResult {
  return { findings: [], checkedPaths: [], conflicts: [], resolved: [], pending: [] };
}

// The same-flow open pull requests the reconcile gate weighs a verify finding
// against. Read once per lens run (or once per completion).
export async function verifyLensOpenPullRequests(
  ctx: AppContext,
  flowId: string | undefined
): Promise<OpenPullRequestSummary[]> {
  return openPullRequestSummaries(await sameFlowOpenProposals(ctx, flowId));
}

// Folds one document's verdict into a lens result: the single place a verdict
// becomes findings/conflicts, shared by the lens (a verdict returned directly)
// and the patrol's continuation (a verdict that arrived with a completed job).
export function foldVerdict(
  result: VerifyLensResult,
  flowId: string | undefined,
  path: string,
  verdict: VerifyDocumentJobOutput,
  openPrs: OpenPullRequestSummary[]
): void {
  // A real verdict came back (healthy or unprovable), so this doc was genuinely checked.
  result.checkedPaths.push(path);

  // Source conflicts and resolutions are collected BEFORE the healthy
  // early-return: a document whose only finding is a conflict is "healthy"
  // (there is nothing about the document to correct — the disagreement is in
  // the sources), so gathering them after it would silently drop every conflict
  // that did not happen to arrive alongside a stale claim.
  for (const conflict of verdict.conflicts ?? []) {
    result.conflicts.push({ ...conflict, path });
  }
  for (const entry of verdict.resolvedConflicts ?? []) {
    result.resolved.push({ ...entry, path });
  }

  if (verdict.verdict === "healthy" || verdict.claims.length === 0) {
    return;
  }

  const decision = decideReconciliation(verifyIntent(flowId, path, verdict.claims), openPrs);
  result.findings.push({
    path,
    claims: verdict.claims,
    decision: decision.kind === "fold" ? "fold" : decision.kind === "defer" ? "defer" : "open-new",
    ...(decision.kind === "fold" ? { intoProposalId: decision.intoProposalId } : {})
  });
}

export async function runVerifyLens(
  ctx: AppContext,
  input: {
    flowId: string | undefined;
    documents: Array<{ path: string; content: string }>;
    sources: SourceDescriptor[];
    verifyDocument: VerifyDocumentFn;
  }
): Promise<VerifyLensResult> {
  const openPrs = await verifyLensOpenPullRequests(ctx, input.flowId);
  const result = emptyVerifyLensResult();

  for (const document of input.documents) {
    // The document's open conflicts, handed to the agent so it re-checks each one
    // and reports it still-conflicted or resolved instead of re-raising it as
    // novel (which would re-annotate). Omitted when empty so an unconflicted
    // document's rendered prompt stays byte-identical to a pre-conflict verify.
    const openConflicts = await ctx.stores.sourceConflicts.listOpenForDocument(input.flowId, document.path);
    const knownConflicts = openConflicts.map((conflict) => ({
      id: conflict.id,
      topic: conflict.topic,
      summary: conflict.summary
    }));

    let outcome: Awaited<ReturnType<VerifyDocumentFn>>;
    try {
      outcome = await input.verifyDocument(ctx, {
        path: document.path,
        content: document.content,
        sources: input.sources,
        flowId: input.flowId,
        ...(knownConflicts.length > 0 ? { knownConflicts } : {})
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "verify failed";
      logger.warn({ path: document.path, err: message }, "verify lens: skipping document");
      continue;
    }

    if (!outcome) {
      continue;
    }
    if ("pendingJobId" in outcome) {
      // Enqueued, not answered: the job's completion folds the verdict in.
      result.pending.push({ path: document.path, jobId: outcome.pendingJobId });
      continue;
    }
    foldVerdict(result, input.flowId, document.path, outcome, openPrs);
  }

  return result;
}
