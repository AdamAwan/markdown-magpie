import type { AppContext } from "../../context.js";
import type {
  CorrectDocumentJobInput,
  DedupeDocumentsJobInput,
  ImproveDocumentJobInput,
  MaintenanceRun,
  SplitDocumentJobInput,
  VerifyDocumentJobInput,
  VerifyFinding,
  ChangeIntentTrace
} from "@magpie/core";
import { verifyDocumentInputSchema, verifyDocumentOutputSchema } from "@magpie/jobs";
import { selectFlow } from "../../platform/repositories.js";
import { selectPatrolBatch } from "../../scheduling/patrol-cursor.js";
import { hashDocumentContent, hashProvenanceClaims, hashSourceDescriptors } from "../../scheduling/patrol-hash.js";
import { foldProvenanceEvents } from "../proposals/provenance.js";
import { projectSourceDescriptors } from "../../platform/source-descriptors.js";
import type { PatrolStamp } from "../../stores/patrol-store.js";
import { flowCoveredPaths } from "../../scheduling/flow.js";
import { runVerifyLens, type VerifyDocumentFn } from "../../scheduling/verify-lens.js";
import { runDedupeLens, type DedupeDocumentFn } from "../../scheduling/dedupe-lens.js";
import { runSplitLens, type SplitDocumentFn } from "../../scheduling/split-lens.js";
import { parseCompletedJobOutput, runJobToCompletion } from "../jobs/service.js";
import { type AiProviderName } from "../../platform/providers.js";
import { createFanoutBudget, type FanoutBudget } from "../../platform/maintenance-fanout.js";
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
      findings: VerifyFinding[];
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

// Dedupe key for reuseKey (#162): a verify already in flight for this document —
// routed to the same provider AND grounded in the same source configuration AND
// told about the same folded citedClaims — is the same piece of work a
// concurrent patrol tick would otherwise duplicate, so wait on it instead of
// enqueueing another. The descriptor hash matters: the change gate is
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
  return `${parsed.data.provider}:${parsed.data.path}:${hashSourceDescriptors(parsed.data.sources)}:${hashProvenanceClaims(parsed.data.citedClaims ?? [])}`;
}

// Default verify: enqueue a verify_document AI job and bounded-wait for the watcher
// to complete it (mirrors gap-reconciler's reshape job). Returns undefined on any
// non-completion so the lens skips that document rather than failing the tick.

// Cap on the bounded wait for one verify job. The queue expiry is 15 min (agentic
// headroom), but the patrol tick runs inside the watcher's 15-minute maintenance
// POST envelope — letting the wait follow the expiry would hand the whole
// envelope to one hung verify, so it is capped at the 10-minute agentic timeout
// the job itself runs under. A CAP, not an override: a tighter configured global
// bound (JOB_RUN_TO_COMPLETION_TIMEOUT_MS — the test harness relies on it to keep
// bounded waits at 100ms) still wins below.
const VERIFY_WAIT_BUDGET_MS = 10 * 60_000;

// Cap on how many merged-proposal provenance events the fold reads per document.
// A cap, not pagination: the query returns the OLDEST events first, so hitting
// it means every merge after the fiftieth was ignored — which must be visible
// to operators rather than silently reading as full provenance coverage.
const PROVENANCE_EVENT_CAP = 50;

// Default verify: enqueue a verify_document AI job THROUGH the fan-out budget and
// bounded-wait for it. A shed (budget/capacity) makes runJobToCompletion throw
// MaintenanceShedError, which runVerifyLens catches like any other verify failure
// — so the doc is simply not in `checkedPaths` and stays re-checkable next tick.
function makeDefaultVerifyDocument(budget: FanoutBudget): VerifyDocumentFn {
  return async (ctx, { path, content, sources, flowId }) => {
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
      // Attribution only — lets the read-time cost rollups credit this verify's
      // spend to the flow's correctness patrol. Omitted for the unscoped flow so
      // the rendered prompt input stays byte-identical.
      ...(flowId !== undefined ? { flowId } : {}),
      provider: ctx.config.get().aiProvider
    } satisfies VerifyDocumentJobInput & { provider: AiProviderName };
    let terminal;
    try {
      terminal = await runJobToCompletion(ctx, "verify_document", input, {
        reuseKey: verifyDocumentReuseKey,
        deadlineMs: Math.min(
          VERIFY_WAIT_BUDGET_MS,
          ctx.settings.jobs.runToCompletionTimeoutMs ?? VERIFY_WAIT_BUDGET_MS
        ),
        admission: { budget }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "verify job failed";
      logger.warn({ path, err: message }, "verify lens: verify_document could not run");
      return undefined;
    }
    if (terminal.state !== "completed") {
      return undefined;
    }
    return parseCompletedJobOutput(verifyDocumentOutputSchema, terminal.output);
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
  const contentHashByPath = new Map(actionableDocuments.map((doc) => [doc.path, hashDocumentContent(doc.content)]));
  const toCheck = actionableDocuments.filter((doc) => {
    const prior = priorByPath.get(doc.path);
    return !(prior?.contentHash === contentHashByPath.get(doc.path) && prior?.sourcesHash === sourcesHash);
  });
  const gated = actionableDocuments.length - toCheck.length;

  // Run the verify lens over the documents that actually need checking this tick.
  const selectedSet = new Set(toCheck.map((doc) => doc.path));
  const selectedDocuments = toCheck.map((doc) => ({ path: doc.path, content: doc.content }));
  const { findings, checkedPaths } = await runVerifyLens(ctx, {
    flowId: options.flowId,
    documents: selectedDocuments,
    sources,
    verifyDocument
  });

  // Each unprovable finding becomes a corrective proposal: enqueue a correct_document
  // job grounded in the same source material the verify lens saw. Enqueue-only — the
  // proposal is drafted and gated later, on job completion.
  for (const finding of findings) {
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
      flowId: options.flowId
    });
  }

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

  const run = await ctx.stores.maintenanceRuns.record({
    taskType: "correctness_patrol",
    flowId: options.flowId,
    trigger: options.trigger,
    status: "completed",
    summary:
      `checked ${checkedPaths.length}/${universe.length} doc${checkedPaths.length === 1 ? "" : "s"} · ` +
      `${findings.length} finding${findings.length === 1 ? "" : "s"}` +
      (gated > 0 ? ` · ${gated} unchanged` : "") +
      (skipped > 0 ? ` · ${skipped} covered by open PRs` : ""),
    details: {
      universeCount: universe.length,
      selectedCount: selected.length,
      selected,
      skipped,
      gated,
      findings,
      intentTraces: verifyFindingIntentTraces(findings, options.flowId),
      fanout
    }
  });
  logger.info(
    {
      trigger: options.trigger,
      flowId: options.flowId ?? "(default)",
      selected: selected.length,
      checked: checkedPaths.length,
      gated,
      universe: universe.length,
      findings: findings.length,
      dedupeScans,
      splitScans,
      skipped,
      runId: run.id
    },
    "fix-patrol completed"
  );
  return {
    ok: true,
    runId: run.id,
    universeCount: universe.length,
    selectedCount: selected.length,
    selected,
    findings
  };
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
