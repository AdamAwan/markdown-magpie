import type { AppContext } from "../../context.js";
import type {
  CorrectDocumentJobInput,
  DedupeDocumentsJobInput,
  ImproveDocumentJobInput,
  MaintenanceRun,
  SplitDocumentJobInput,
  VerifyDocumentJobInput,
  VerifyFinding
} from "@magpie/core";
import { verifyDocumentOutputSchema } from "@magpie/jobs";
import { selectFlow } from "../../platform/repositories.js";
import { selectPatrolBatch } from "../../scheduling/patrol-cursor.js";
import { runVerifyLens, type VerifyDocumentFn } from "../../scheduling/verify-lens.js";
import { runDedupeLens, type DedupeDocumentFn } from "../../scheduling/dedupe-lens.js";
import { runSplitLens, type SplitDocumentFn } from "../../scheduling/split-lens.js";
import { collectSourceContext } from "../../platform/source-context.js";
import { runJobToCompletion } from "../jobs/service.js";
import { type AiProviderName } from "../../platform/providers.js";

// Cursor knobs (tunable). batchSize bounds per-tick cost; randomCount is the
// explore share (~20%); the remainder is the oldest/most-stale exploit share.
// See docs/maintenance-redesign.md (Decisions: cursor fairness).
const PATROL_BATCH_SIZE = 10;
const PATROL_RANDOM_COUNT = 2;
const IMPROVE_PATROL_BATCH_SIZE = 2;
const IMPROVE_PATROL_RANDOM_COUNT = 1;

export type FixPatrolOutcome =
  | { ok: true; runId: string; universeCount: number; selectedCount: number; selected: string[]; findings: VerifyFinding[] }
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

// Default verify: enqueue a verify_document AI job and bounded-wait for the watcher
// to complete it (mirrors gap-reconciler's reshape job). Returns undefined on any
// non-completion so the lens skips that document rather than failing the tick.
const defaultVerifyDocument: VerifyDocumentFn = async (ctx, { path, content, sources }) => {
  const input = {
    path,
    content,
    sources,
    provider: ctx.config.get().aiProvider
  } satisfies VerifyDocumentJobInput & { provider: AiProviderName };
  let terminal;
  try {
    terminal = await runJobToCompletion(ctx, "verify_document", input);
  } catch (error) {
    const message = error instanceof Error ? error.message : "verify job failed";
    console.warn(`Verify lens: verify_document for ${path} could not run — ${message}.`);
    return undefined;
  }
  if (terminal.state !== "completed") {
    return undefined;
  }
  const parsed = verifyDocumentOutputSchema.safeParse(terminal.output);
  return parsed.success ? parsed.data : undefined;
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
    sources: input.sources,
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
    sources: input.sources,
    destinationId: input.destinationId,
    flowId: input.flowId,
    provider: ctx.config.get().aiProvider
  } satisfies ImproveDocumentJobInput & { provider: AiProviderName });
};

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

  const selected = selectPatrolBatch(universe, checkedAt, {
    batchSize: PATROL_BATCH_SIZE,
    randomCount: PATROL_RANDOM_COUNT
  });

  // Run the verify lens over the selected documents. The source material is the
  // same for every document in the flow, so collect it once per tick — and only
  // when there is at least one document to check.
  const selectedSet = new Set(selected);
  const selectedDocuments = documents
    .filter((doc) => selectedSet.has(doc.path))
    .map((doc) => ({ path: doc.path, content: doc.content }));
  const sources = selectedDocuments.length > 0 ? await collectSourceContext(ctx.repositoryDeps(), scope.sourceIds) : [];
  const findings = await runVerifyLens(ctx, {
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

  await ctx.stores.patrol.stampChecked(options.flowId, selected);

  const run = await ctx.stores.maintenanceRuns.record({
    taskType: "fix_patrol",
    flowId: options.flowId,
    trigger: options.trigger,
    status: "completed",
    summary:
      `checked ${selected.length}/${universe.length} doc${selected.length === 1 ? "" : "s"} · ` +
      `${findings.length} finding${findings.length === 1 ? "" : "s"}`,
    details: { universeCount: universe.length, selectedCount: selected.length, selected, findings }
  });
  console.log(
    `Fix-patrol (${options.trigger}) flow=${options.flowId ?? "(default)"}: ` +
      `checked ${selected.length}/${universe.length} document(s), ${findings.length} finding(s), ` +
      `${dedupeScans} dedupe scan(s), ${splitScans} split scan(s) enqueued; run ${run.id}.`
  );
  return { ok: true, runId: run.id, universeCount: universe.length, selectedCount: selected.length, selected, findings };
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
  const selected = selectPatrolBatch(universe, checkedAt, {
    batchSize: IMPROVE_PATROL_BATCH_SIZE,
    randomCount: IMPROVE_PATROL_RANDOM_COUNT
  });

  const selectedSet = new Set(selected);
  const selectedDocuments = documents
    .filter((doc) => selectedSet.has(doc.path))
    .map((doc) => ({ path: doc.path, content: doc.content, repositoryId: doc.repositoryId }));
  const sources = selectedDocuments.length > 0 ? await collectSourceContext(ctx.repositoryDeps(), scope.sourceIds) : [];

  let enqueuedCount = 0;
  for (const document of selectedDocuments) {
    try {
      await improveDocument(ctx, {
        path: document.path,
        content: document.content,
        sources,
        destinationId: document.repositoryId,
        flowId: options.flowId
      });
      enqueuedCount += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "improve failed";
      console.warn(`Improve-patrol: skipping ${document.path} - ${message}.`);
    }
  }

  await ctx.stores.patrol.stampChecked(options.flowId, selected, "improve");
  const run = await ctx.stores.maintenanceRuns.record({
    taskType: "improve_patrol",
    flowId: options.flowId,
    trigger: options.trigger,
    status: "completed",
    summary:
      `checked ${selected.length}/${universe.length} doc${selected.length === 1 ? "" : "s"} · ` +
      `${enqueuedCount} improve scan${enqueuedCount === 1 ? "" : "s"}`,
    details: { universeCount: universe.length, selectedCount: selected.length, selected, enqueuedCount }
  });
  console.log(
    `Improve-patrol (${options.trigger}) flow=${options.flowId ?? "(default)"}: ` +
      `checked ${selected.length}/${universe.length} document(s), ${enqueuedCount} improve scan(s) enqueued; run ${run.id}.`
  );
  return { ok: true, runId: run.id, universeCount: universe.length, selectedCount: selected.length, selected, enqueuedCount };
}
