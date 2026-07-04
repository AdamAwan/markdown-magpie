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
import { verifyDocumentOutputSchema } from "@magpie/jobs";
import { selectFlow } from "../../platform/repositories.js";
import { selectPatrolBatch } from "../../scheduling/patrol-cursor.js";
import { hashDocumentContent, hashSourceCorpus } from "../../scheduling/patrol-hash.js";
import type { PatrolStamp } from "../../stores/patrol-store.js";
import { flowCoveredPaths } from "../../scheduling/flow.js";
import { runVerifyLens, type VerifyDocumentFn } from "../../scheduling/verify-lens.js";
import { runDedupeLens, type DedupeDocumentFn } from "../../scheduling/dedupe-lens.js";
import { runSplitLens, type SplitDocumentFn } from "../../scheduling/split-lens.js";
import { collectSourceContext } from "../../platform/source-context.js";
import { parseCompletedJobOutput, runJobToCompletion } from "../jobs/service.js";
import { type AiProviderName } from "../../platform/providers.js";
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

// Dedupe key for reuseKey (#162): a verify already in flight for this document
// (routed to the same provider) is the same piece of work a concurrent patrol
// tick would otherwise duplicate, so wait on it instead of enqueueing another.
function verifyDocumentReuseKey(input: unknown): string {
  if (!input || typeof input !== "object") return "unknown";
  const candidate = input as { path?: unknown; provider?: unknown };
  const path = typeof candidate.path === "string" ? candidate.path : "__unknown__";
  const provider = typeof candidate.provider === "string" ? candidate.provider : "__unknown__";
  return `${provider}:${path}`;
}

// Default verify: enqueue a verify_document AI job and bounded-wait for the watcher
// to complete it (mirrors gap-reconciler's reshape job). Returns undefined on any
// non-completion so the lens skips that document rather than failing the tick.
const defaultVerifyDocument: VerifyDocumentFn = async (ctx, { path, content, sourcesRef }) => {
  const input = {
    path,
    content,
    sourcesRef,
    provider: ctx.config.get().aiProvider
  } satisfies VerifyDocumentJobInput & { provider: AiProviderName };
  let terminal;
  try {
    terminal = await runJobToCompletion(ctx, "verify_document", input, { reuseKey: verifyDocumentReuseKey });
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

// Runs the corrective repair for one document. The default enqueues a
// correct_document AI job (enqueue-only — the corrective proposal is drafted and
// gated later, on job completion, via completeJob); tests inject a spy/fake.
export type CorrectDocumentFn = (ctx: AppContext, input: CorrectDocumentJobInput) => Promise<void>;

const defaultCorrectDocument: CorrectDocumentFn = async (ctx, input) => {
  await ctx.jobs.create("correct_document", {
    path: input.path,
    content: input.content,
    claims: input.claims,
    sourcesRef: input.sourcesRef,
    destinationId: input.destinationId,
    flowId: input.flowId,
    provider: ctx.config.get().aiProvider
  } satisfies CorrectDocumentJobInput & { provider: AiProviderName });
};

// Default dedupe: enqueue a dedupe_documents AI job (enqueue-only — the corrective
// proposal is drafted and gated later, on job completion). Tests inject a spy/fake.
const defaultDedupeDocument: DedupeDocumentFn = async (ctx, input) => {
  await ctx.jobs.create("dedupe_documents", {
    path: input.path,
    content: input.content,
    neighbours: input.neighbours,
    destinationId: input.destinationId,
    flowId: input.flowId,
    provider: ctx.config.get().aiProvider
  } satisfies DedupeDocumentsJobInput & { provider: AiProviderName });
};

// Default split: enqueue a split_document AI job (enqueue-only - the corrective
// proposal is drafted and gated later, on job completion).
const defaultSplitDocument: SplitDocumentFn = async (ctx, input) => {
  await ctx.jobs.create("split_document", {
    path: input.path,
    content: input.content,
    neighbours: input.neighbours,
    destinationId: input.destinationId,
    flowId: input.flowId,
    provider: ctx.config.get().aiProvider
  } satisfies SplitDocumentJobInput & { provider: AiProviderName });
};

export type ImproveDocumentFn = (ctx: AppContext, input: ImproveDocumentJobInput) => Promise<void>;

const defaultImproveDocument: ImproveDocumentFn = async (ctx, input) => {
  await ctx.jobs.create("improve_document", {
    path: input.path,
    content: input.content,
    sourcesRef: input.sourcesRef,
    destinationId: input.destinationId,
    flowId: input.flowId,
    provider: ctx.config.get().aiProvider
  } satisfies ImproveDocumentJobInput & { provider: AiProviderName });
};

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
  } = {}
): Promise<FixPatrolOutcome> {
  const verifyDocument = deps.verifyDocument ?? defaultVerifyDocument;
  const correctDocument = deps.correctDocument ?? defaultCorrectDocument;
  const dedupeDocument = deps.dedupeDocument ?? defaultDedupeDocument;
  const splitDocument = deps.splitDocument ?? defaultSplitDocument;
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

  // The source material is the same for every document in the flow, so collect it
  // once per tick — and only when there is at least one document to consider. It's
  // needed up front (before any lens runs) so the change gate below can hash it.
  const actionableSet = new Set(actionable);
  const actionableDocuments = documents.filter((doc) => actionableSet.has(doc.path));
  const sources =
    actionableDocuments.length > 0 ? await collectSourceContext(ctx.repositoryDeps(), scope.sourceIds) : [];
  const sourcesHash = hashSourceCorpus(sources);

  // Change gate (#163): skip the (provider-billed) lenses for any document whose body
  // AND the source corpus are byte-identical to the last time it was checked — the
  // verdict cannot have changed, so re-running verify/dedupe/split would burn calls to
  // re-learn a known result. A never-checked doc (no recorded hash) and any hash
  // mismatch fall through to a full check. On an idle KB this drops the tick to ~zero
  // provider/embedding calls while the cursor still rotates (all selected docs are
  // stamped below, unchanged ones with their existing hash preserved).
  const contentHashByPath = new Map(actionableDocuments.map((doc) => [doc.path, hashDocumentContent(doc.content)]));
  const toCheck = actionableDocuments.filter((doc) => {
    const prior = priorByPath.get(doc.path);
    return !(prior?.contentHash === contentHashByPath.get(doc.path) && prior?.sourcesHash === sourcesHash);
  });
  const gated = actionableDocuments.length - toCheck.length;

  // Persist the corpus ONCE per tick, content-addressed by its hash, so the
  // verify/correct jobs below carry only that ref instead of a by-value copy of
  // the whole corpus each (#163 Part 2). Saved only when at least one doc will be
  // checked (i.e. a job that references it will be enqueued).
  if (toCheck.length > 0) {
    await ctx.stores.sourceCorpus.save(sourcesHash, sources);
  }

  // Run the verify lens over the documents that actually need checking this tick.
  const selectedSet = new Set(toCheck.map((doc) => doc.path));
  const selectedDocuments = toCheck.map((doc) => ({ path: doc.path, content: doc.content }));
  const { findings, checkedPaths } = await runVerifyLens(ctx, {
    flowId: options.flowId,
    documents: selectedDocuments,
    sourcesRef: sourcesHash,
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
      sourcesRef: sourcesHash,
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
  // state. See buildPatrolStamps.
  await ctx.stores.patrol.stampChecked(
    options.flowId,
    buildPatrolStamps(selected, new Set(checkedPaths), contentHashByPath, sourcesHash)
  );

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
      intentTraces: verifyFindingIntentTraces(findings, options.flowId)
    }
  });
  logger.info(
    { trigger: options.trigger, flowId: options.flowId ?? "(default)", selected: selected.length, checked: checkedPaths.length, gated, universe: universe.length, findings: findings.length, dedupeScans, splitScans, skipped, runId: run.id },
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
  deps: { improveDocument?: ImproveDocumentFn } = {}
): Promise<ImprovePatrolOutcome> {
  const improveDocument = deps.improveDocument ?? defaultImproveDocument;
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

  const actionableSet = new Set(actionable);
  const actionableDocuments = documents.filter((doc) => actionableSet.has(doc.path));
  const sources =
    actionableDocuments.length > 0 ? await collectSourceContext(ctx.repositoryDeps(), scope.sourceIds) : [];
  const sourcesHash = hashSourceCorpus(sources);

  // Change gate (#163): an improve scan of a doc that is byte-identical against a
  // byte-identical source corpus would re-propose the same edit, so skip enqueueing
  // it. Never-checked docs and any hash mismatch fall through and are scanned.
  const contentHashByPath = new Map(actionableDocuments.map((doc) => [doc.path, hashDocumentContent(doc.content)]));
  const toCheck = actionableDocuments.filter((doc) => {
    const prior = priorByPath.get(doc.path);
    return !(prior?.contentHash === contentHashByPath.get(doc.path) && prior?.sourcesHash === sourcesHash);
  });
  const gated = actionableDocuments.length - toCheck.length;

  // Persist the corpus once per tick (see runFixPatrol) so each improve scan carries
  // only a ref to it rather than a by-value copy (#163 Part 2).
  if (toCheck.length > 0) {
    await ctx.stores.sourceCorpus.save(sourcesHash, sources);
  }

  const checkedPaths = new Set<string>();
  let enqueuedCount = 0;
  for (const document of toCheck) {
    try {
      await improveDocument(ctx, {
        path: document.path,
        content: document.content,
        sourcesRef: sourcesHash,
        destinationId: document.repositoryId,
        flowId: options.flowId
      });
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
    details: { universeCount: universe.length, selectedCount: selected.length, selected, skipped, gated, enqueuedCount }
  });
  logger.info(
    { trigger: options.trigger, flowId: options.flowId ?? "(default)", selected: selected.length, universe: universe.length, enqueued: enqueuedCount, gated, skipped, runId: run.id },
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
