import type {
  SourceDescriptor,
  UnprovableClaim,
  VerifyDocumentJobInput,
  VerifyDocumentJobOutput,
  VerifyFinding
} from "@magpie/core";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";
import type { ChangeIntent } from "./intent.js";
import { decideReconciliation, openPullRequestSummaries } from "./reconcile-gate.js";
import { sameFlowOpenProposals } from "./flow.js";

// Runs the verify check for one document. The default implementation (in the
// patrol service) enqueues a verify_document AI job and bounded-waits for it;
// tests inject a deterministic fake. Returns undefined when the verdict could not
// be obtained (job failed/timed out/malformed) so the lens simply skips that doc.
export type VerifyDocumentFn = (
  ctx: AppContext,
  input: VerifyDocumentJobInput & { flowId: string | undefined }
) => Promise<VerifyDocumentJobOutput | undefined>;

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
// verdict (healthy or not) this tick. A doc whose verify threw, timed out, or
// returned nothing is NOT in checkedPaths — so the caller's change gate never
// records a "verified" hash for a doc it did not actually verify, which would
// otherwise suppress it forever after a transient provider outage (#163).
export interface VerifyLensResult {
  findings: VerifyFinding[];
  checkedPaths: string[];
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
  const openPrs = openPullRequestSummaries(await sameFlowOpenProposals(ctx, input.flowId));
  const findings: VerifyFinding[] = [];
  const checkedPaths: string[] = [];

  for (const document of input.documents) {
    let verdict: VerifyDocumentJobOutput | undefined;
    try {
      verdict = await input.verifyDocument(ctx, {
        path: document.path,
        content: document.content,
        sources: input.sources,
        flowId: input.flowId
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "verify failed";
      logger.warn({ path: document.path, err: message }, "verify lens: skipping document");
      continue;
    }

    if (!verdict) {
      continue;
    }
    // A real verdict came back (healthy or unprovable), so this doc was genuinely checked.
    checkedPaths.push(document.path);

    if (verdict.verdict === "healthy" || verdict.claims.length === 0) {
      continue;
    }

    const decision = decideReconciliation(verifyIntent(input.flowId, document.path, verdict.claims), openPrs);
    findings.push({
      path: document.path,
      claims: verdict.claims,
      decision: decision.kind === "fold" ? "fold" : decision.kind === "defer" ? "defer" : "open-new",
      ...(decision.kind === "fold" ? { intoProposalId: decision.intoProposalId } : {})
    });
  }

  return { findings, checkedPaths };
}
