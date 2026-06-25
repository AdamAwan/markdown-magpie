import type { AppContext } from "../../context.js";
import type { CorrectDocumentJobInput, PatrolRun, VerifyDocumentJobInput } from "@magpie/core";
import { verifyDocumentOutputSchema } from "@magpie/jobs";
import { selectFlow } from "../../platform/repositories.js";
import { selectPatrolBatch } from "../../scheduling/patrol-cursor.js";
import { runVerifyLens, type VerifyDocumentFn } from "../../scheduling/verify-lens.js";
import { collectSourceContext } from "../../platform/source-context.js";
import { runJobToCompletion } from "../jobs/service.js";
import { type AiProviderName } from "../../platform/providers.js";

// Cursor knobs (tunable). batchSize bounds per-tick cost; randomCount is the
// explore share (~20%); the remainder is the oldest/most-stale exploit share.
// See docs/maintenance-redesign.md (Decisions: cursor fairness).
const PATROL_BATCH_SIZE = 10;
const PATROL_RANDOM_COUNT = 2;

export type FixPatrolOutcome = { ok: true; run: PatrolRun } | { ok: false; code: "unknown_flow" };

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

export async function runFixPatrol(
  ctx: AppContext,
  options: { flowId?: string; trigger: PatrolRun["trigger"] },
  deps: { verifyDocument?: VerifyDocumentFn; correctDocument?: CorrectDocumentFn } = {}
): Promise<FixPatrolOutcome> {
  const verifyDocument = deps.verifyDocument ?? defaultVerifyDocument;
  const correctDocument = deps.correctDocument ?? defaultCorrectDocument;
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

  await ctx.stores.patrol.stampChecked(options.flowId, selected);

  const run = await ctx.stores.patrol.createRun({
    flowId: options.flowId,
    trigger: options.trigger,
    universeCount: universe.length,
    selectedCount: selected.length,
    selected,
    findings
  });
  console.log(
    `Fix-patrol (${options.trigger}) flow=${options.flowId ?? "(default)"}: ` +
      `checked ${selected.length}/${universe.length} document(s), ${findings.length} finding(s); run ${run.id}.`
  );
  return { ok: true, run };
}

export async function listRuns(ctx: AppContext, limit: number): Promise<PatrolRun[]> {
  return ctx.stores.patrol.listRuns(limit);
}

export async function getRun(ctx: AppContext, id: string): Promise<PatrolRun | undefined> {
  return ctx.stores.patrol.getRun(id);
}
