import type { AppContext } from "../../context.js";
import type {
  CorrectDocumentJobInput,
  DedupeDocumentsJobInput,
  ImproveDocumentJobInput,
  MaintenanceRun,
  SourceDescriptor,
  SplitDocumentJobInput,
  VerifyDocumentJobInput,
  VerifyFinding,
  ChangeIntentTrace
} from "@magpie/core";
import { verifyDocumentInputSchema, verifyDocumentOutputSchema, type JobView } from "@magpie/jobs";
import { z } from "zod";
import { selectFlow } from "../../platform/repositories.js";
import { selectPatrolBatch } from "../../scheduling/patrol-cursor.js";
import { hashDocumentContent, hashProvenanceClaims, hashSourceDescriptors } from "../../scheduling/patrol-hash.js";
import { foldProvenanceEvents } from "../proposals/provenance.js";
import { projectSourceDescriptors } from "../../platform/source-descriptors.js";
import type { PatrolStamp } from "../../stores/patrol-store.js";
import { flowCoveredPaths } from "../../scheduling/flow.js";
import {
  emptyVerifyLensResult,
  foldVerdict,
  runVerifyLens,
  verifyLensOpenPullRequests,
  type VerifyDocumentFn,
  type VerifyLensResult
} from "../../scheduling/verify-lens.js";
import { withFlowRunLockWaiting } from "../../scheduling/run-lock.js";
import type { OrchestrationFollowup } from "../../stores/orchestration-followup-store.js";
import { runDedupeLens, type DedupeDocumentFn } from "../../scheduling/dedupe-lens.js";
import { runSplitLens, type SplitDocumentFn } from "../../scheduling/split-lens.js";
import { IN_FLIGHT_JOB_STATES, parseCompletedJobOutput } from "../jobs/service.js";
import { type AiProviderName } from "../../platform/providers.js";
import { createFanoutBudget, type FanoutBudget } from "../../platform/maintenance-fanout.js";
import { annotateConflict, repairResolvedConflict } from "./conflict-annotation.js";
import { logger } from "../../logger.js";

// Cursor knobs (tunable). batchSize bounds per-tick cost; randomCount is the
// explore share (~20%); the remainder is the oldest/most-stale exploit share.
// See docs/maintenance-redesign.md (Decisions: cursor fairness).
const PATROL_BATCH_SIZE = 10;
const PATROL_RANDOM_COUNT = 2;
const IMPROVE_PATROL_BATCH_SIZE = 2;
const IMPROVE_PATROL_RANDOM_COUNT = 1;

export type FixPatrolOutcome =
  | {
      ok: true;
      runId: string;
      universeCount: number;
      selectedCount: number;
      selected: string[];
      // Findings, conflicts and resolutions from verdicts that were available
      // within the tick. With the default (enqueued) verify these are empty at
      // return: each verify_document job's completion applies its own verdict and
      // adds it to the run (see continueFixPatrolFromCompletedVerify).
      findings: VerifyFinding[];
      conflictCount: number;
      resolvedConflictCount: number;
      // Verifies enqueued this tick that had not answered when it returned.
      pendingVerifyCount: number;
    }
  | { ok: false; code: "unknown_flow" };
export type ImprovePatrolOutcome =
  | { ok: true; runId: string; universeCount: number; selectedCount: number; selected: string[]; enqueuedCount: number }
  | { ok: false; code: "unknown_flow" };

// Resolve a flow to the repository ids whose documents the cursor rotates over and
// the source ids whose material the verify lens checks against. Mirrors the
// retrieve/source-sync services: a flow scopes to its destination repo + its
// sources; the default flow (undefined) is unscoped (every indexed repository) and
// uses the default source set.
function resolveScope(
  ctx: AppContext,
  flowId: string | undefined
):
  | { ok: true; repositoryIds: string[] | undefined; sourceIds: string[] | undefined }
  | { ok: false; code: "unknown_flow" } {
  if (!flowId) {
    return { ok: true, repositoryIds: undefined, sourceIds: undefined };
  }
  const flow = selectFlow(ctx.repositoryDeps(), flowId);
  if (!flow) {
    return { ok: false, code: "unknown_flow" };
  }
  return {
    ok: true,
    repositoryIds: flow.destinationId ? [flow.destinationId] : undefined,
    sourceIds: flow.sourceIds
  };
}

// Dedupe key (#162): a verify already in flight for this document — routed to the
// same provider AND grounded in the same source configuration AND told about the
// same folded citedClaims — is the same piece of work a concurrent patrol tick
// would otherwise duplicate, so it is reused instead of enqueueing another. The descriptor hash matters: the change gate is
// config-keyed now, so a verdict reused across a config change would stamp a
// sourcesHash no verify ever explored and gate the doc on it. The claims hash
// (#214 phase 2) matters the same way: a merge can change a document's folded
// provenance without touching its body, and reusing across that change would
// return a verdict computed against claims the job was never told about.
function verifyDocumentReuseKey(input: unknown): string {
  const parsed = verifyDocumentInputSchema.safeParse(input);
  if (!parsed.success) {
    return "unknown";
  }
  // The known-conflict ids matter for the same reason the claims hash does: a
  // verify told about a different set of open conflicts is different work, and
  // reusing across that change would return a verdict computed without the
  // conflicts the job was meant to re-check (so none of them could resolve).
  const conflictIds = (parsed.data.knownConflicts ?? [])
    .map((conflict) => conflict.id)
    .sort()
    .join(",");
  return `${parsed.data.provider}:${parsed.data.path}:${hashSourceDescriptors(parsed.data.sources)}:${hashProvenanceClaims(parsed.data.citedClaims ?? [])}:${conflictIds}`;
}

// Cap on how many merged-proposal provenance events the fold reads per document.
// A cap, not pagination: the query returns the OLDEST events first, so hitting
// it means every merge after the fiftieth was ignored — which must be visible
// to operators rather than silently reading as full provenance coverage.
const PROVENANCE_EVENT_CAP = 50;

// Default verify: enqueue a verify_document AI job THROUGH the fan-out budget and
// return at once — the tick never waits for it. The verdict is applied when the
// job completes (continueFixPatrolFromCompletedVerify). A verify already in
// flight for the same work is reused, spending no budget. A shed (budget/
// capacity) or an enqueue failure returns undefined, so the doc is simply not
// checked this tick and stays re-checkable on the next.
function makeDefaultVerifyDocument(budget: FanoutBudget): VerifyDocumentFn {
  return async (ctx, { path, content, sources, flowId, knownConflicts }) => {
    // #214 phase 2: fold the document's provenance event stream (its merged
    // proposals) into advisory citedClaims the verify agent checks first. An
    // empty fold omits the field entirely so the job input — and therefore the
    // rendered prompt — is byte-identical to a pre-provenance verify.
    const events = await ctx.stores.proposals.listMergedByTargetPath(path, PROVENANCE_EVENT_CAP);
    if (events.length === PROVENANCE_EVENT_CAP) {
      logger.warn(
        { path, cap: PROVENANCE_EVENT_CAP },
        "verify lens: provenance event cap reached; events beyond the oldest 50 merges were ignored"
      );
    }
    const citedClaims = foldProvenanceEvents(events, content);
    const input = {
      path,
      content,
      sources,
      ...(citedClaims.length > 0 ? { citedClaims } : {}),
      // The lens supplies the document's open conflicts (it owns conflict
      // routing); pass them straight through.
      ...(knownConflicts && knownConflicts.length > 0 ? { knownConflicts } : {}),
      // Attribution only — lets the read-time cost rollups credit this verify's
      // spend to the flow's correctness patrol. Omitted for the unscoped flow so
      // the rendered prompt input stays byte-identical.
      ...(flowId !== undefined ? { flowId } : {}),
      provider: ctx.config.get().aiProvider
    } satisfies VerifyDocumentJobInput & { provider: AiProviderName };
    try {
      const reuseKey = verifyDocumentReuseKey(input);
      const { jobs } = await ctx.jobs.list({ type: "verify_document", limit: 200 });
      const inFlight = jobs.find(
        (job) => IN_FLIGHT_JOB_STATES.has(job.state) && verifyDocumentReuseKey(job.input) === reuseKey
      );
      if (inFlight) {
        // Reuse spends NO budget/capacity: an in-flight job already holds its slot.
        return { pendingJobId: inFlight.id };
      }
      const admission = await budget.admit("verify_document", input);
      if (!admission.ok) {
        logger.warn({ path, reason: admission.reason }, "verify lens: verify_document shed by the fan-out budget");
        return undefined;
      }
      return { pendingJobId: admission.job.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : "verify job failed";
      logger.warn({ path, err: message }, "verify lens: verify_document could not be enqueued");
      return undefined;
    }
  };
}

// Runs the corrective repair for one document. The default enqueues a
// correct_document AI job (enqueue-only — the corrective proposal is drafted and
// gated later, on job completion, via completeJob); tests inject a spy/fake.
export type CorrectDocumentFn = (ctx: AppContext, input: CorrectDocumentJobInput) => Promise<void>;

// Records a shed path so the caller can leave the doc re-checkable (not stamp it
// as checked). The enqueue-only lenses call the *Document Fns for their effect,
// not their return value, so a shed is signalled out-of-band via this shared set.
function makeDefaultCorrectDocument(budget: FanoutBudget, deferredPaths: Set<string>): CorrectDocumentFn {
  return async (ctx, input) => {
    const admission = await budget.admit("correct_document", {
      path: input.path,
      content: input.content,
      claims: input.claims,
      sources: input.sources,
      destinationId: input.destinationId,
      flowId: input.flowId,
      provider: ctx.config.get().aiProvider
    } satisfies CorrectDocumentJobInput & { provider: AiProviderName });
    if (!admission.ok) {
      deferredPaths.add(input.path);
    }
  };
}

// Default dedupe: enqueue a dedupe_documents AI job through the budget. Tests
// inject a spy/fake.
function makeDefaultDedupeDocument(budget: FanoutBudget, deferredPaths: Set<string>): DedupeDocumentFn {
  return async (ctx, input) => {
    const admission = await budget.admit("dedupe_documents", {
      path: input.path,
      content: input.content,
      neighbours: input.neighbours,
      destinationId: input.destinationId,
      flowId: input.flowId,
      provider: ctx.config.get().aiProvider
    } satisfies DedupeDocumentsJobInput & { provider: AiProviderName });
    if (!admission.ok) {
      deferredPaths.add(input.path);
    }
  };
}

// Default split: enqueue a split_document AI job through the budget.
function makeDefaultSplitDocument(budget: FanoutBudget, deferredPaths: Set<string>): SplitDocumentFn {
  return async (ctx, input) => {
    const admission = await budget.admit("split_document", {
      path: input.path,
      content: input.content,
      neighbours: input.neighbours,
      destinationId: input.destinationId,
      flowId: input.flowId,
      provider: ctx.config.get().aiProvider
    } satisfies SplitDocumentJobInput & { provider: AiProviderName });
    if (!admission.ok) {
      deferredPaths.add(input.path);
    }
  };
}

export type ImproveDocumentFn = (ctx: AppContext, input: ImproveDocumentJobInput) => Promise<void>;

// Default improve: enqueue an improve_document AI job through the budget. On a
// shed the path is recorded so runImprovePatrol leaves the doc unstamped (thus
// re-checkable), mirroring an enqueue failure.
function makeDefaultImproveDocument(budget: FanoutBudget, deferredPaths: Set<string>): ImproveDocumentFn {
  return async (ctx, input) => {
    const admission = await budget.admit("improve_document", {
      path: input.path,
      content: input.content,
      sources: input.sources,
      destinationId: input.destinationId,
      flowId: input.flowId,
      provider: ctx.config.get().aiProvider
    } satisfies ImproveDocumentJobInput & { provider: AiProviderName });
    if (!admission.ok) {
      deferredPaths.add(input.path);
    }
  };
}

function verifyFindingIntentTraces(findings: VerifyFinding[], flowId: string | undefined): ChangeIntentTrace[] {
  const createdAt = new Date().toISOString();
  return findings.map((finding) => ({
    createdAt,
    intent: {
      lens: "verify",
      ...(flowId ? { flowId } : {}),
      targets: [finding.path],
      evidence: finding.claims.map((claim) => claim.claim),
      rationale:
        finding.claims
          .map((claim) => claim.reason)
          .filter(Boolean)
          .join("; ") || "Verify lens found unprovable claims."
    },
    decision:
      finding.decision === "fold"
        ? { kind: "fold", intoProposalId: finding.intoProposalId ?? "unknown" }
        : finding.decision === "defer"
          ? { kind: "defer", behindProposalId: finding.intoProposalId ?? "unknown" }
          : { kind: "open-new" },
    candidatePullRequests: [],
    outcome: finding.intoProposalId
      ? { proposalId: finding.intoProposalId }
      : {
          reason:
            finding.decision === "open-new"
              ? "No overlapping open proposal blocked a new corrective proposal."
              : undefined
        }
  }));
}

// Builds the cursor stamps for a patrol tick. Every selected doc is stamped so it
// rotates in the staleness cursor, but a fresh content/source hash is recorded only
// for the docs actually checked this tick — a checked doc's current hash becomes its
// new verified state, while every other doc (gated as unchanged, covered by an open
// PR, or one whose check failed) gets a bare stamp that advances its timestamp and
// preserves whatever hash it already held. This keeps a doc whose check did not
// complete re-checkable rather than gating it on a state it was never verified at.
function buildPatrolStamps(
  selected: string[],
  checkedPaths: Set<string>,
  contentHashByPath: Map<string, string>,
  sourcesHash: string
): PatrolStamp[] {
  return selected.map((path) => {
    const contentHash = contentHashByPath.get(path);
    return checkedPaths.has(path) && contentHash ? { docPath: path, contentHash, sourcesHash } : path;
  });
}

export async function runFixPatrol(
  ctx: AppContext,
  options: { flowId?: string; trigger: MaintenanceRun["trigger"] },
  deps: {
    verifyDocument?: VerifyDocumentFn;
    correctDocument?: CorrectDocumentFn;
    dedupeDocument?: DedupeDocumentFn;
    splitDocument?: SplitDocumentFn;
    // Injected so a test can pin the per-tick fan-out budget; production creates
    // one per tick (#288b). The default* enqueue closures admit through it.
    budget?: FanoutBudget;
  } = {}
): Promise<FixPatrolOutcome> {
  // One fan-out budget for the whole tick, gating every metered enqueue (verify +
  // correct/dedupe/split). deferredPaths collects docs whose enqueue-only fan-out
  // was shed so they are left unstamped (re-checkable) rather than gated.
  const budget = deps.budget ?? createFanoutBudget(ctx, "correctness_patrol", options.flowId);
  const deferredPaths = new Set<string>();
  const verifyDocument = deps.verifyDocument ?? makeDefaultVerifyDocument(budget);
  const correctDocument = deps.correctDocument ?? makeDefaultCorrectDocument(budget, deferredPaths);
  const dedupeDocument = deps.dedupeDocument ?? makeDefaultDedupeDocument(budget, deferredPaths);
  const splitDocument = deps.splitDocument ?? makeDefaultSplitDocument(budget, deferredPaths);
  const scope = resolveScope(ctx, options.flowId);
  if (!scope.ok) {
    return scope;
  }

  // Before selecting anything, settle what earlier ticks of this flow left
  // behind: a verify whose completion-side continuation never ran is applied
  // here, and one whose job died is written off, so no run stays `running`
  // forever and the cursor below reflects every verdict that has arrived.
  await settleStaleFixPatrolRuns(ctx, options.flowId);

  const documents = ctx.stores.knowledgeIndex
    .listDocuments()
    .filter((doc) => !scope.repositoryIds || scope.repositoryIds.includes(doc.repositoryId));
  const universe = documents.map((doc) => doc.path);

  const cursor = await ctx.stores.patrol.listCursor(options.flowId);
  const checkedAt = new Map(cursor.map((entry) => [entry.docPath, entry.lastCheckedAt]));
  const priorByPath = new Map(cursor.map((entry) => [entry.docPath, entry]));

  const selected = selectPatrolBatch(universe, checkedAt, {
    batchSize: PATROL_BATCH_SIZE,
    randomCount: PATROL_RANDOM_COUNT
  });

  // Drop any selected document already covered by an open same-flow proposal: its
  // change is awaiting review in an unmerged PR, so re-scanning it would redraft the
  // same change and fold it in every tick (see flowCoveredPaths). Covered docs stay
  // stamped in the cursor so they rotate normally and become eligible again once the
  // PR merges and its edits reach the index.
  const covered = await flowCoveredPaths(ctx, options.flowId);
  const actionable = selected.filter((path) => !covered.has(path));
  const skipped = selected.length - actionable.length;

  // Project the flow's configured sources into the reference-only descriptors the
  // patrol child jobs are grounded in. Projection is cheap and identical for every
  // document in the tick; its hash is the config half of the change gate below.
  const actionableSet = new Set(actionable);
  const actionableDocuments = documents.filter((doc) => actionableSet.has(doc.path));
  const sources = projectSourceDescriptors(ctx.repositoryDeps(), scope.sourceIds);
  const sourcesHash = hashSourceDescriptors(sources);

  // Change gate (#163): skip the (provider-billed) lenses for any document whose body
  // AND the flow's source configuration are identical to the last time it was checked
  // — the verdict cannot have changed, so re-running verify/dedupe/split would burn
  // calls to re-learn a known result. A never-checked doc (no recorded hash) and any
  // hash mismatch fall through to a full check. On an idle KB this drops the tick to
  // ~zero provider/embedding calls while the cursor still rotates (all selected docs
  // are stamped below, unchanged ones with their existing hash preserved). Note that
  // pre-migration cursor rows hold corpus-based hashes, so every doc re-checks once
  // after deploy (intended: one full re-verify under grounded exploration).
  //
  // Documents with an OPEN source conflict are exempt. The gate re-arms on
  // document content or source *configuration* only — a source-content change
  // deliberately does not bust it (see hashSourceDescriptors). Once a conflicted
  // document is annotated, its body and its descriptors are both stable, so the
  // gate would skip it on every future tick: the policy or the code gets fixed
  // out in the sources and Magpie never looks again, leaving the conflict open
  // forever. The exemption is self-limiting — it applies only to the documents
  // where a source-content change is precisely the awaited event.
  const contentHashByPath = new Map(actionableDocuments.map((doc) => [doc.path, hashDocumentContent(doc.content)]));
  const conflictedPaths = new Set(await ctx.stores.sourceConflicts.listOpenPaths(options.flowId));
  const toCheck = actionableDocuments.filter((doc) => {
    if (conflictedPaths.has(doc.path)) {
      return true;
    }
    const prior = priorByPath.get(doc.path);
    return !(prior?.contentHash === contentHashByPath.get(doc.path) && prior?.sourcesHash === sourcesHash);
  });
  const gated = actionableDocuments.length - toCheck.length;

  // Start the verify lens over the documents that actually need checking this
  // tick. With the default verify this ENQUEUES one verify_document job per
  // document and comes back with them `pending`; nothing here waits on a watcher.
  const selectedSet = new Set(toCheck.map((doc) => doc.path));
  const selectedDocuments = toCheck.map((doc) => ({ path: doc.path, content: doc.content }));
  const lens = await runVerifyLens(ctx, {
    flowId: options.flowId,
    documents: selectedDocuments,
    sources,
    verifyDocument
  });
  const { findings, checkedPaths, conflicts } = lens;

  // Act on the verdicts already in hand (none, with the default verify — each
  // pending job's completion runs this same routine for its own document).
  const repairedCount = await applyVerifyResults(ctx, {
    flowId: options.flowId,
    documents,
    sources,
    lens,
    correctDocument
  });

  // Run the dedupe lens over the same batch: for each selected document, find its
  // nearest neighbours and enqueue a dedupe_documents scan when any are close enough.
  // The neighbour search is scoped to the same repositories as the cursor.
  const dedupeScans = await runDedupeLens(ctx, {
    flowId: options.flowId,
    documents: documents
      .filter((doc) => selectedSet.has(doc.path))
      .map((doc) => ({ path: doc.path, content: doc.content, repositoryId: doc.repositoryId })),
    repositoryIds: scope.repositoryIds,
    dedupeDocument
  });

  // Run the split lens over the same batch: broad or oversized documents are sent
  // to a multi-file changeset proposal flow that can move material into focused
  // documents and clean up touched neighbours.
  const splitScans = await runSplitLens(ctx, {
    flowId: options.flowId,
    documents: documents
      .filter((doc) => selectedSet.has(doc.path))
      .map((doc) => ({ path: doc.path, content: doc.content, repositoryId: doc.repositoryId })),
    repositoryIds: scope.repositoryIds,
    splitDocument
  });

  // Stamp the whole selection so the cursor rotates, but record a fresh
  // content/source hash ONLY for docs the verify lens actually checked this tick —
  // so a doc whose verify failed (or was gated/covered) keeps its prior verified
  // hash (or none) and stays re-checkable rather than being gated on an unverified
  // state. See buildPatrolStamps. A doc whose corrective/dedupe/split enqueue was
  // shed by the fan-out budget (deferredPaths) is pulled back out of the checked
  // set the same way: leaving it unstamped keeps its fan-out re-checkable next tick
  // instead of gating a doc whose corrective work never got enqueued.
  const stampedChecked = new Set(checkedPaths);
  for (const path of deferredPaths) {
    stampedChecked.delete(path);
  }
  await ctx.stores.patrol.stampChecked(
    options.flowId,
    buildPatrolStamps(selected, stampedChecked, contentHashByPath, sourcesHash)
  );
  budget.finish();
  const fanout = budget.snapshot();

  const tick: FixPatrolTickDetails = {
    universeCount: universe.length,
    selectedCount: selected.length,
    selected,
    skipped,
    gated,
    fanout
  };
  const inTick: VerifyOutcomeTotals = {
    checked: checkedPaths.length,
    findings,
    conflicts,
    resolvedConflicts: repairedCount
  };
  // Recorded `running` while verifies are outstanding: its findings are not known
  // yet. finalizeFixPatrolRun rewrites it as each one settles and completes it
  // after the last. With nothing pending this is the terminal record, as before.
  const run = await ctx.stores.maintenanceRuns.record({
    taskType: "correctness_patrol",
    flowId: options.flowId,
    trigger: options.trigger,
    status: lens.pending.length > 0 ? "running" : "completed",
    summary: fixPatrolSummary(tick, inTick, lens.pending.length),
    details: fixPatrolDetails(tick, inTick, options.flowId, lens.pending.length)
  });

  if (lens.pending.length > 0) {
    // Tie each pending verify to this run so its completion can find its way back.
    // A doc whose dedupe/split enqueue was shed this tick must stay re-checkable,
    // so its verify is told not to record a verified hash (stampHash: false).
    for (const pending of lens.pending) {
      await ctx.stores.orchestrationFollowups.register({
        jobId: pending.jobId,
        orchestrator: "correctness_patrol",
        scopeKey: run.id,
        context: {
          ...(options.flowId ? { flowId: options.flowId } : {}),
          path: pending.path,
          stampHash: !deferredPaths.has(pending.path)
        }
      });
    }
    // A verify can complete before its row exists (the rows are written after the
    // lens returns): its completion then finds no row and does nothing. This pass
    // closes that window — any verify of this run that is already complete is
    // applied now — and is the same routine a later tick uses to self-heal.
    await settleFixPatrolRun(ctx, run.id);
  }

  logger.info(
    {
      trigger: options.trigger,
      flowId: options.flowId ?? "(default)",
      selected: selected.length,
      checked: checkedPaths.length,
      pendingVerifies: lens.pending.length,
      gated,
      universe: universe.length,
      findings: findings.length,
      conflicts: conflicts.length,
      conflictsResolved: repairedCount,
      dedupeScans,
      splitScans,
      skipped,
      runId: run.id
    },
    lens.pending.length > 0 ? "fix-patrol enqueued verifies" : "fix-patrol completed"
  );
  return {
    ok: true,
    runId: run.id,
    universeCount: universe.length,
    selectedCount: selected.length,
    selected,
    findings,
    conflictCount: conflicts.length,
    resolvedConflictCount: repairedCount,
    pendingVerifyCount: lens.pending.length
  };
}

// Acts on a set of verify verdicts: annotate source conflicts, repair resolved
// ones, and enqueue a corrective job per unprovable finding. Shared by the tick
// (verdicts available in-tick) and the continuation (one document's verdict,
// arriving with its completed verify_document job), so both do exactly the same
// thing with a verdict. Returns how many resolved conflicts were repaired.
async function applyVerifyResults(
  ctx: AppContext,
  args: {
    flowId: string | undefined;
    documents: ReadonlyArray<{ path: string; content: string; repositoryId: string }>;
    sources: SourceDescriptor[];
    lens: Pick<VerifyLensResult, "findings" | "conflicts" | "resolved">;
    correctDocument: CorrectDocumentFn;
  }
): Promise<number> {
  const { flowId, documents, sources, lens, correctDocument } = args;

  // Source conflicts: record each one and, when it is new, annotate the document
  // so it stops silently asserting a disputed value. These never become
  // corrective proposals — no correction can settle a disagreement between two
  // sources without Magpie choosing a winner.
  for (const conflict of lens.conflicts) {
    const document = documents.find((doc) => doc.path === conflict.path);
    if (!document) {
      continue;
    }
    try {
      await annotateConflict(ctx, {
        flowId,
        conflict,
        content: document.content,
        destinationId: document.repositoryId
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "annotation failed";
      logger.warn({ path: conflict.path, err: message }, "fix-patrol: conflict annotation failed");
    }
  }

  // Conflicts the agent reported the sources now agree on: close the register
  // entry and repair the document through the ordinary corrective path.
  let repairedCount = 0;
  for (const entry of lens.resolved) {
    const document = documents.find((doc) => doc.path === entry.path);
    if (!document) {
      continue;
    }
    try {
      const repaired = await repairResolvedConflict(ctx, {
        flowId,
        resolved: entry,
        content: document.content,
        destinationId: document.repositoryId,
        sources,
        correctDocument
      });
      if (repaired) {
        repairedCount += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "repair failed";
      logger.warn({ path: entry.path, err: message }, "fix-patrol: conflict repair failed");
    }
  }

  // Each unprovable finding becomes a corrective proposal: enqueue a correct_document
  // job grounded in the same source material the verify lens saw. Enqueue-only — the
  // proposal is drafted and gated later, on job completion.
  for (const finding of lens.findings) {
    const document = documents.find((doc) => doc.path === finding.path);
    if (!document) {
      continue;
    }
    await correctDocument(ctx, {
      path: finding.path,
      content: document.content,
      claims: finding.claims,
      sources,
      destinationId: document.repositoryId,
      flowId
    });
  }
  return repairedCount;
}

// --- The run record ---------------------------------------------------------
// A correctness-patrol run's details are the tick's fixed facts plus the verify
// outcomes, which arrive over time. They are always recomputed from those two
// parts (never patched in place), so finalising a run twice is harmless.

// What the tick knew when it returned. Stored verbatim on the run.
const fixPatrolTickDetailsSchema = z.object({
  universeCount: z.number(),
  selectedCount: z.number(),
  selected: z.array(z.string()),
  skipped: z.number(),
  gated: z.number(),
  // The tick's fan-out budget summary (FanoutBudgetCounts).
  fanout: z.object({
    taskType: z.string(),
    flowId: z.string(),
    attempted: z.number(),
    enqueued: z.number(),
    deferredByBudget: z.number(),
    rejectedByCapacity: z.number(),
    budget: z.number(),
    runaway: z.boolean()
  })
});
type FixPatrolTickDetails = z.infer<typeof fixPatrolTickDetailsSchema>;

const verifyFindingSchema = z.object({
  path: z.string(),
  claims: verifyDocumentOutputSchema.shape.claims,
  decision: z.enum(["open-new", "fold", "defer"]),
  intoProposalId: z.string().optional()
});
const verifyConflictSchema = verifyDocumentOutputSchema.shape.conflicts.unwrap().element.extend({ path: z.string() });

// Verify outcomes, summed: from the tick, from one settled follow-up, or both.
const verifyOutcomeTotalsSchema = z.object({
  checked: z.number(),
  findings: z.array(verifyFindingSchema),
  conflicts: z.array(verifyConflictSchema),
  resolvedConflicts: z.number()
});
type VerifyOutcomeTotals = z.infer<typeof verifyOutcomeTotalsSchema>;

function fixPatrolSummary(tick: FixPatrolTickDetails, totals: VerifyOutcomeTotals, pending: number): string {
  return (
    `checked ${totals.checked}/${tick.universeCount} doc${totals.checked === 1 ? "" : "s"} · ` +
    `${totals.findings.length} finding${totals.findings.length === 1 ? "" : "s"}` +
    (totals.conflicts.length > 0
      ? ` · ${totals.conflicts.length} source conflict${totals.conflicts.length === 1 ? "" : "s"}`
      : "") +
    (totals.resolvedConflicts > 0
      ? ` · ${totals.resolvedConflicts} conflict${totals.resolvedConflicts === 1 ? "" : "s"} resolved`
      : "") +
    (pending > 0 ? ` · ${pending} verif${pending === 1 ? "y" : "ies"} in progress` : "") +
    (tick.gated > 0 ? ` · ${tick.gated} unchanged` : "") +
    (tick.skipped > 0 ? ` · ${tick.skipped} covered by open PRs` : "")
  );
}

// `inTick` (the outcomes the tick itself produced) and `pendingVerifies` are
// present only on a run that had verifies outstanding — they are what
// finalizeFixPatrolRun recomputes from. A run that never waited on anything
// keeps exactly the details it always had.
function fixPatrolDetails(
  tick: FixPatrolTickDetails,
  totals: VerifyOutcomeTotals,
  flowId: string | undefined,
  pending: number,
  asynchronous?: { inTick: VerifyOutcomeTotals }
): Record<string, unknown> {
  return {
    ...tick,
    findings: totals.findings,
    conflicts: totals.conflicts,
    resolvedConflicts: totals.resolvedConflicts,
    intentTraces: verifyFindingIntentTraces(totals.findings, flowId),
    ...(pending > 0 || asynchronous
      ? { pendingVerifies: pending, checkedCount: totals.checked, inTick: asynchronous?.inTick ?? totals }
      : {})
  };
}

// --- The continuation --------------------------------------------------------

// What a correctness_patrol follow-up row carries (see
// stores/orchestration-followup-store.ts): the flow and document the
// verify_document job checks, and whether its verdict may record a verified hash
// on the patrol cursor (false when the tick shed that doc's dedupe/split
// enqueue, so the doc stays re-checkable).
const verifyFollowupContextSchema = z.object({
  flowId: z.string().optional(),
  path: z.string(),
  stampHash: z.boolean()
});

// The outcome of one verify, as settled on its follow-up row. `checked: false`
// covers every way a verify yields no verdict to act on (the job failed or was
// cancelled, its output was malformed, the document changed or vanished while
// it ran). `stamp` is the cursor stamp to (re-)apply.
const verifyFollowupResultSchema = verifyOutcomeTotalsSchema.extend({
  stamp: z.object({ docPath: z.string(), contentHash: z.string(), sourcesHash: z.string() }).optional()
});
type VerifyFollowupResult = z.infer<typeof verifyFollowupResultSchema>;

const UNCHECKED: VerifyFollowupResult = { checked: 0, findings: [], conflicts: [], resolvedConflicts: 0 };

// THE CONTINUATION. A completed verify_document job that a patrol tick enqueued
// resumes that tick's work for its one document: act on the verdict, stamp the
// cursor, and fold the outcome into the tick's run. Called from the completion
// dispatcher (completeJob) for every completed verify job; one with no follow-up
// row (created by hand) is a no-op.
export async function continueFixPatrolFromCompletedVerify(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<void> {
  if (!job || job.type !== "verify_document") {
    return;
  }
  const followup = await ctx.stores.orchestrationFollowups.get(job.id);
  if (!followup || followup.orchestrator !== "correctness_patrol") {
    return;
  }
  await settleVerifyFollowup(ctx, followup, { kind: "completed", input: job.input, output });
  await finalizeFixPatrolRun(ctx, followup.scopeKey);
}

// A verify_document job a patrol tick enqueued will never produce a verdict (it
// failed terminally or was cancelled). Its document is simply not checked — left
// unstamped, so the next rotation re-verifies it — and the run stops waiting.
export async function abandonFixPatrolVerify(ctx: AppContext, job: JobView | undefined): Promise<void> {
  if (!job || job.type !== "verify_document") {
    return;
  }
  const followup = await ctx.stores.orchestrationFollowups.get(job.id);
  if (!followup || followup.orchestrator !== "correctness_patrol") {
    return;
  }
  await settleVerifyFollowup(ctx, followup, { kind: "abandoned" });
  await finalizeFixPatrolRun(ctx, followup.scopeKey);
}

// Settles one verify follow-up, exactly once. Serialised per job: the completion
// handler, its replay, and a tick's self-heal pass can all reach the same row, and
// two of them acting on one verdict would enqueue two corrective jobs. The row is
// re-read under the lock, so whoever arrives second finds it settled.
//
// The paid step (enqueueing correct_document) happens BEFORE the row settles, and
// the cursor stamp AFTER, read back from the settled row — so a failure anywhere
// replays into "already settled → just re-stamp", never into a second enqueue.
async function settleVerifyFollowup(
  ctx: AppContext,
  followup: OrchestrationFollowup,
  outcome: { kind: "completed"; input: unknown; output: unknown } | { kind: "abandoned" }
): Promise<void> {
  await withFlowRunLockWaiting(ctx.pool, "correctness_patrol_verify", followup.jobId, async () => {
    const current = await ctx.stores.orchestrationFollowups.get(followup.jobId);
    if (!current) {
      return;
    }
    if (current.status === "pending") {
      const result =
        outcome.kind === "completed"
          ? await applyVerifyVerdict(ctx, current, outcome.input, outcome.output)
          : UNCHECKED;
      await ctx.stores.orchestrationFollowups.settle(current.jobId, result);
    }
    const settled = await ctx.stores.orchestrationFollowups.get(followup.jobId);
    const context = verifyFollowupContextSchema.safeParse(settled?.context);
    const result = verifyFollowupResultSchema.safeParse(settled?.result);
    if (context.success && result.success && result.data.stamp) {
      await ctx.stores.patrol.stampChecked(context.data.flowId, [result.data.stamp]);
    }
  });
}

// Acts on one completed verify's verdict and reports what it did. Anything that
// leaves no trustworthy verdict returns UNCHECKED, which records no verified
// hash — the document stays re-checkable rather than gated on a state nobody
// verified (#163).
async function applyVerifyVerdict(
  ctx: AppContext,
  followup: OrchestrationFollowup,
  jobInput: unknown,
  jobOutput: unknown
): Promise<VerifyFollowupResult> {
  const context = verifyFollowupContextSchema.safeParse(followup.context);
  const input = verifyDocumentInputSchema.safeParse(jobInput);
  const verdict = parseCompletedJobOutput(verifyDocumentOutputSchema, jobOutput);
  if (!context.success || !input.success || !verdict) {
    logger.warn({ jobId: followup.jobId }, "fix-patrol: verify_document completion could not be read; doc not checked");
    return UNCHECKED;
  }
  const { flowId, path, stampHash } = context.data;
  const scope = resolveScope(ctx, flowId);
  if (!scope.ok) {
    return UNCHECKED;
  }
  const document = ctx.stores.knowledgeIndex
    .listDocuments()
    .find((doc) => doc.path === path && (!scope.repositoryIds || scope.repositoryIds.includes(doc.repositoryId)));
  const contentHash = hashDocumentContent(input.data.content);
  if (!document || hashDocumentContent(document.content) !== contentHash) {
    // The document was re-indexed (or removed) while the verify ran. The verdict
    // describes content that is no longer there: acting on it could annotate or
    // "correct" the wrong text, and stamping it would gate the new content on a
    // check it never had. Drop it; the next rotation verifies the current doc.
    logger.info({ path, jobId: followup.jobId }, "fix-patrol: document changed while its verify ran; verdict dropped");
    return UNCHECKED;
  }

  const lens = emptyVerifyLensResult();
  foldVerdict(lens, flowId, path, verdict, await verifyLensOpenPullRequests(ctx, flowId));

  // The tick that enqueued this verify is long gone, and its budget with it, so
  // the corrective enqueue admits through a budget of its own. The global
  // non-interactive ceiling still bounds it.
  const budget = createFanoutBudget(ctx, "correctness_patrol", flowId);
  const deferredPaths = new Set<string>();
  const resolvedConflicts = await applyVerifyResults(ctx, {
    flowId,
    documents: [document],
    sources: input.data.sources,
    lens,
    correctDocument: makeDefaultCorrectDocument(budget, deferredPaths)
  });
  budget.finish();

  // Record the verified hash only when the tick allowed it AND the corrective
  // work this verdict called for was actually enqueued — a shed leaves the doc
  // unstamped so the next tick retries it.
  const stamp =
    stampHash && !deferredPaths.has(path)
      ? { docPath: path, contentHash, sourcesHash: hashSourceDescriptors(input.data.sources) }
      : undefined;
  return {
    checked: 1,
    findings: lens.findings,
    conflicts: lens.conflicts,
    resolvedConflicts,
    ...(stamp ? { stamp } : {})
  };
}

// Recomputes a run's status, summary and details from the tick's facts plus
// every verify outcome settled so far, and completes it once none are pending.
// Idempotent and safe to race: each caller settles its own row first and then
// recomputes from what is stored, so whoever runs last writes the full picture.
async function finalizeFixPatrolRun(ctx: AppContext, runId: string): Promise<void> {
  const run = await ctx.stores.maintenanceRuns.get(runId);
  if (!run || run.taskType !== "correctness_patrol") {
    return;
  }
  const tick = fixPatrolTickDetailsSchema.safeParse(run.details);
  const inTick = verifyOutcomeTotalsSchema.safeParse(run.details.inTick);
  if (!tick.success || !inTick.success) {
    return;
  }
  const rows = await ctx.stores.orchestrationFollowups.listByScope("correctness_patrol", runId);
  const totals: VerifyOutcomeTotals = {
    checked: inTick.data.checked,
    findings: [...inTick.data.findings],
    conflicts: [...inTick.data.conflicts],
    resolvedConflicts: inTick.data.resolvedConflicts
  };
  let pending = 0;
  for (const row of rows) {
    if (row.status === "pending") {
      pending += 1;
      continue;
    }
    const result = verifyFollowupResultSchema.safeParse(row.result);
    if (!result.success) {
      continue;
    }
    totals.checked += result.data.checked;
    totals.findings.push(...result.data.findings);
    totals.conflicts.push(...result.data.conflicts);
    totals.resolvedConflicts += result.data.resolvedConflicts;
  }
  await ctx.stores.maintenanceRuns.update(runId, {
    status: pending > 0 ? "running" : "completed",
    summary: fixPatrolSummary(tick.data, totals, pending),
    details: fixPatrolDetails(tick.data, totals, run.flowId, pending, { inTick: inTick.data })
  });
}

// Settles every verify of one run whose JOB has reached a terminal state but
// whose row is still pending — an outcome nobody applied. A completed job is
// applied through the same routine its completion handler uses; a failed,
// cancelled or vanished one is abandoned. Verifies still queued or running are
// left alone. Then the run is recomputed.
async function settleFixPatrolRun(ctx: AppContext, runId: string): Promise<void> {
  for (const row of await ctx.stores.orchestrationFollowups.listByScope("correctness_patrol", runId)) {
    if (row.status !== "pending") {
      continue;
    }
    let job: JobView | undefined;
    try {
      job = await ctx.jobs.get(row.jobId);
    } catch (error) {
      // The broker could not say. Leave the row pending; a later tick asks again.
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ jobId: row.jobId, err: message }, "fix-patrol: could not read verify job state");
      continue;
    }
    if (job && IN_FLIGHT_JOB_STATES.has(job.state)) {
      continue;
    }
    await settleVerifyFollowup(
      ctx,
      row,
      job?.state === "completed" ? { kind: "completed", input: job.input, output: job.output } : { kind: "abandoned" }
    );
  }
  await finalizeFixPatrolRun(ctx, runId);
}

// How many of a flow's recent runs a tick re-examines for unsettled verifies.
// Runs settle within minutes; this only has to reach back past a few ticks.
const STALE_RUN_SCAN_LIMIT = 50;
// Settled follow-up rows are kept this long (they back a run's details until it
// completes, and are useful for audit shortly after), then pruned.
const FOLLOWUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Self-healing, run at the start of every tick: finish any earlier run of this
// flow still marked `running`. Covers the cases no completion handler will — the
// watcher gave up re-POSTing a completion, the API restarted mid-continuation, a
// job expired inside the queue without anyone calling failJob.
async function settleStaleFixPatrolRuns(ctx: AppContext, flowId: string | undefined): Promise<void> {
  const recent = await ctx.stores.maintenanceRuns.list({
    taskType: "correctness_patrol",
    ...(flowId !== undefined ? { flowId } : {}),
    limit: STALE_RUN_SCAN_LIMIT
  });
  for (const run of recent) {
    // list() treats an absent flowId as "any flow", so match the flow explicitly.
    if (run.status === "running" && run.flowId === flowId) {
      await settleFixPatrolRun(ctx, run.id);
    }
  }
  await ctx.stores.orchestrationFollowups.pruneSettledBefore(
    new Date(Date.now() - FOLLOWUP_RETENTION_MS).toISOString()
  );
}

export async function runImprovePatrol(
  ctx: AppContext,
  options: { flowId?: string; trigger: MaintenanceRun["trigger"] },
  deps: { improveDocument?: ImproveDocumentFn; budget?: FanoutBudget } = {}
): Promise<ImprovePatrolOutcome> {
  const budget = deps.budget ?? createFanoutBudget(ctx, "editorial_patrol", options.flowId);
  const deferredPaths = new Set<string>();
  const improveDocument = deps.improveDocument ?? makeDefaultImproveDocument(budget, deferredPaths);
  const scope = resolveScope(ctx, options.flowId);
  if (!scope.ok) {
    return scope;
  }

  const documents = ctx.stores.knowledgeIndex
    .listDocuments()
    .filter((doc) => !scope.repositoryIds || scope.repositoryIds.includes(doc.repositoryId));
  const universe = documents.map((doc) => doc.path);

  const cursor = await ctx.stores.patrol.listCursor(options.flowId, "improve");
  const checkedAt = new Map(cursor.map((entry) => [entry.docPath, entry.lastCheckedAt]));
  const priorByPath = new Map(cursor.map((entry) => [entry.docPath, entry]));
  const selected = selectPatrolBatch(universe, checkedAt, {
    batchSize: IMPROVE_PATROL_BATCH_SIZE,
    randomCount: IMPROVE_PATROL_RANDOM_COUNT
  });

  // Skip any selected document already covered by an open same-flow proposal — the
  // improve change would otherwise be redrafted and folded into the open PR every
  // tick (see flowCoveredPaths). The cursor still stamps the full selection below.
  const covered = await flowCoveredPaths(ctx, options.flowId);
  const actionable = selected.filter((path) => !covered.has(path));
  const skipped = selected.length - actionable.length;

  // Project the flow's configured sources into the reference-only descriptors the
  // improve scans are grounded in (see runFixPatrol). Projection is cheap and
  // identical for every document in the tick; its hash is the config half of the
  // change gate below.
  const actionableSet = new Set(actionable);
  const actionableDocuments = documents.filter((doc) => actionableSet.has(doc.path));
  const sources = projectSourceDescriptors(ctx.repositoryDeps(), scope.sourceIds);
  const sourcesHash = hashSourceDescriptors(sources);

  // Change gate (#163): an improve scan of a doc that is byte-identical against an
  // identical source configuration would re-propose the same edit, so skip
  // enqueueing it. Never-checked docs and any hash mismatch fall through and are
  // scanned.
  const contentHashByPath = new Map(actionableDocuments.map((doc) => [doc.path, hashDocumentContent(doc.content)]));
  const toCheck = actionableDocuments.filter((doc) => {
    const prior = priorByPath.get(doc.path);
    return !(prior?.contentHash === contentHashByPath.get(doc.path) && prior?.sourcesHash === sourcesHash);
  });
  const gated = actionableDocuments.length - toCheck.length;

  const checkedPaths = new Set<string>();
  let enqueuedCount = 0;
  for (const document of toCheck) {
    try {
      await improveDocument(ctx, {
        path: document.path,
        content: document.content,
        sources,
        destinationId: document.repositoryId,
        flowId: options.flowId
      });
      // A fan-out shed leaves the doc in deferredPaths — treat it exactly like a
      // failed enqueue: unrecorded, so it stays re-checkable next tick.
      if (deferredPaths.has(document.path)) {
        continue;
      }
      // The scan was enqueued, so this doc was processed this tick: record its hash so
      // an unchanged doc is gated next time. A failed enqueue leaves it unrecorded and
      // thus re-checkable.
      checkedPaths.add(document.path);
      enqueuedCount += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "improve failed";
      logger.warn({ path: document.path, err: message }, "improve-patrol: skipping document");
    }
  }
  budget.finish();
  const fanout = budget.snapshot();

  await ctx.stores.patrol.stampChecked(
    options.flowId,
    buildPatrolStamps(selected, checkedPaths, contentHashByPath, sourcesHash),
    "improve"
  );
  const run = await ctx.stores.maintenanceRuns.record({
    taskType: "editorial_patrol",
    flowId: options.flowId,
    trigger: options.trigger,
    status: "completed",
    summary:
      `checked ${enqueuedCount}/${universe.length} doc${enqueuedCount === 1 ? "" : "s"} · ` +
      `${enqueuedCount} improve scan${enqueuedCount === 1 ? "" : "s"}` +
      (gated > 0 ? ` · ${gated} unchanged` : "") +
      (skipped > 0 ? ` · ${skipped} covered by open PRs` : ""),
    details: {
      universeCount: universe.length,
      selectedCount: selected.length,
      selected,
      skipped,
      gated,
      enqueuedCount,
      fanout
    }
  });
  logger.info(
    {
      trigger: options.trigger,
      flowId: options.flowId ?? "(default)",
      selected: selected.length,
      universe: universe.length,
      enqueued: enqueuedCount,
      gated,
      skipped,
      runId: run.id
    },
    "improve-patrol completed"
  );
  return {
    ok: true,
    runId: run.id,
    universeCount: universe.length,
    selectedCount: selected.length,
    selected,
    enqueuedCount
  };
}
