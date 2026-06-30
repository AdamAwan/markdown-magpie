import type {
  ChangesetChange,
  KnowledgeDocument,
  MaintenancePlan,
  RankedSection,
  SourceChangeFile,
  SourceChangeSyncJobInput,
  SourceSyncCandidateDocument,
  SourceSyncRun,
  SourceSyncRunTrigger
} from "@magpie/core";
import type { JobView } from "@magpie/jobs";
import {
  syncSourceChangesGeneratePlanInputSchema,
  syncSourceChangesGeneratePlanOutputSchema
} from "@magpie/jobs";
import {
  diffChangedFiles,
  ensureGitCheckout,
  getHeadSha,
  type SourceFileChange
} from "@magpie/git";
import type { AppContext } from "../../context.js";
import {
  defaultDestinationId,
  selectFlow
} from "../../platform/repositories.js";
import type { ConfiguredKnowledgeRepository } from "../../stores/knowledge-repositories.js";
import { normalizeRelativePath } from "../../platform/paths.js";
import { type AiProviderName } from "../../platform/providers.js";
import type { ProposalInput } from "../../stores/proposal-store.js";
import * as foldService from "../../scheduling/fold.js";
import { logger } from "../../logger.js";

// How many retrieved sections to consider, and how many distinct documents to
// hand the model as editable candidates. Kept small so the model sees only the
// documents most likely to describe the changed behaviour.
const RETRIEVAL_SECTION_LIMIT = 12;
const CANDIDATE_DOCUMENT_LIMIT = 6;
// The retrieval query (changed paths + diffs) is capped so a large commit can't
// blow up the embedding/keyword query.
const RETRIEVAL_QUERY_MAX_CHARS = 6_000;

// Watches every git source of a flow (or, with no flow, every configured git
// source) for new commits and reacts to each. Returns one run per source that
// actually had a new commit to consider; sources with no change since last time
// produce no run. Each source is independent — one failing source can't abort
// the others.
export async function triggerSourceSyncRun(
  ctx: AppContext,
  options: { flowId?: string; trigger: SourceSyncRunTrigger }
): Promise<SourceSyncRun[]> {
  const deps = ctx.repositoryDeps();
  const flow = selectFlow(deps, options.flowId);
  const flowId = flow?.id ?? options.flowId;
  const destinationId = flow?.destinationId ?? defaultDestinationId(deps);

  const sourceIds = flow ? flow.sourceIds : deps.knowledgeConfig.sources.map((source) => source.id);
  const sources = sourceIds
    .map((id) => deps.knowledgeConfig.sources.find((source) => source.id === id))
    .filter((source): source is ConfiguredKnowledgeRepository => Boolean(source) && source!.kind === "git" && Boolean(source!.url));

  const runs: SourceSyncRun[] = [];
  for (const source of sources) {
    try {
      const run = await syncGitSource(ctx, { flowId, destinationId, source, trigger: options.trigger });
      if (run) {
        runs.push(run);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "source sync failed";
      logger.warn({ sourceId: source.id, flowId: flowId ?? "default", err: message }, "source-change sync failed");
    }
  }

  return runs;
}

async function syncGitSource(
  ctx: AppContext,
  args: {
    flowId: string | undefined;
    destinationId: string | undefined;
    source: ConfiguredKnowledgeRepository;
    trigger: SourceSyncRunTrigger;
  }
): Promise<SourceSyncRun | undefined> {
  const { flowId, destinationId, source, trigger } = args;
  const store = ctx.stores.sourceSync;

  const checkout = await ensureGitCheckout({
    id: source.id,
    url: source.url!,
    branch: source.branch,
    checkoutRoot: ctx.knowledgeConfig.checkoutRoot
  });
  const headSha = await getHeadSha(checkout.localPath);
  if (!headSha) {
    // Not a usable git checkout (empty clone, detached, etc.) — nothing to do.
    return undefined;
  }

  const previous = await store.getState(flowId, source.id);
  if (!previous) {
    // First time we've seen this source: record a baseline so the *next* commit
    // is what we react to. Reacting to the entire history on first run would be
    // noise.
    await store.setState(flowId, source.id, headSha);
    logger.info({ sourceId: source.id, flowId: flowId ?? "default", sha: headSha.slice(0, 8) }, "source-change sync baselined");
    return undefined;
  }

  if (previous.lastSha === headSha) {
    return undefined; // No new commits.
  }

  const changes = await diffChangedFiles(checkout.localPath, previous.lastSha, headSha, { subpath: source.subpath });
  if (changes.length === 0) {
    // Commits landed but nothing inside the watched subpath changed.
    await store.setState(flowId, source.id, headSha);
    return undefined;
  }

  const candidateDocuments = selectCandidateDocuments(
    await ctx.stores.knowledgeIndex.search(buildRetrievalQuery(changes), RETRIEVAL_SECTION_LIMIT, destinationId ? [destinationId] : undefined),
    ctx.stores.knowledgeIndex.listDocuments(),
    CANDIDATE_DOCUMENT_LIMIT
  );

  // The "if the KB already contains that info" gate: with no document describing
  // the changed area, there is nothing to correct.
  if (candidateDocuments.length === 0) {
    const run = await store.createRun({
      flowId,
      destinationId,
      sourceId: source.id,
      trigger,
      status: "skipped",
      fromSha: previous.lastSha,
      toSha: headSha,
      changedFileCount: changes.length,
      candidateCount: 0
    });
    await store.setState(flowId, source.id, headSha);
    logger.info({ sourceId: source.id, changedFiles: changes.length }, "source-change sync: changed files but no matching knowledge — skipped");
    return run;
  }

  // Planning is enqueue-only (mirrors crunch's triggerCrunchRun): enqueue the
  // generative job, record a "running" run linked to it, and advance the baseline
  // now so the next tick won't re-react to the same commit while the plan is in
  // flight. The watcher produces the plan; attachSourceSyncPlanFromCompletedJob then
  // constrains it to a candidate-only changeset, completes the run, and enqueues
  // publication. A plan-job failure fails the run (jobs/failJob), and pg-boss already
  // retries provider work before that terminal failure. Nothing here blocks on the
  // model, so the maintenance /api/source-sync/run call returns immediately.
  const input = {
    flowId,
    destinationId,
    sourceId: source.id,
    sourceName: source.name,
    fromSha: previous.lastSha,
    toSha: headSha,
    changes: changes.map(toSourceChangeFile),
    candidateDocuments,
    expectedOutput: "maintenance_plan",
    provider: ctx.config.get().aiProvider
  } satisfies SourceChangeSyncJobInput & { provider: AiProviderName };

  const job = await ctx.jobs.create("sync_source_changes_generate_plan", input);
  const run = await store.createRun({
    flowId,
    destinationId,
    sourceId: source.id,
    trigger,
    status: "running",
    jobId: job.id,
    fromSha: previous.lastSha,
    toSha: headSha,
    changedFileCount: changes.length,
    candidateCount: candidateDocuments.length
  });
  await store.setState(flowId, source.id, headSha);
  logger.info({ sourceId: source.id, jobId: job.id, changedFiles: changes.length, candidates: candidateDocuments.length, runId: run.id }, "source-change sync: enqueued plan job");
  return run;
}

// Completion handler for sync_source_changes_generate_plan jobs (enqueue-only flow,
// mirrors crunch's attachMaintenancePlanFromCompletedJob). The watcher produced the plan;
// constrain it to the candidate documents the job was given (defence-in-depth: only
// ever write back documents we offered, and never delete — a source-sync corrects
// existing docs, it does not remove knowledge), then complete the linked run with the
// derived changeset and enqueue publication. An empty changeset means the change
// needed no KB edit, so the run is recorded as skipped. Idempotent: only a
// still-"running" run is transitioned, so a re-delivered completion is a no-op.
export async function attachSourceSyncPlanFromCompletedJob(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<void> {
  if (!job || job.type !== "sync_source_changes_generate_plan") {
    return;
  }
  const run = await ctx.stores.sourceSync.getRunByJobId(job.id);
  if (!run || run.status !== "running") {
    return;
  }

  const parsed = syncSourceChangesGeneratePlanOutputSchema.safeParse(output);
  if (!parsed.success) {
    await ctx.stores.sourceSync.failRun(run.id, "source-sync plan job returned malformed output");
    return;
  }

  const changeset = constrainToCandidates(changesetFromPlan(parsed.data), readCandidateDocuments(job.input));
  if (changeset.length === 0) {
    await ctx.stores.sourceSync.markSkipped(run.id, parsed.data);
    return;
  }

  const completed = await ctx.stores.sourceSync.completeRun(run.id, parsed.data, changeset);
  if (!completed) {
    return;
  }
  const existing = await ctx.stores.proposals.getByJobId(job.id);
  const proposal = existing ?? await ctx.stores.proposals.create(sourceSyncProposalInput(completed, parsed.data, changeset, job));
  await foldService.reconcileSourceSyncProposal(ctx, proposal);
}

// Reads back the candidate documents the plan job was given so the completion handler
// can constrain the plan to them. The input was validated at enqueue, so a parse
// failure is not expected; degrade to an empty set (⇒ empty changeset ⇒ skipped)
// rather than throwing inside the completion dispatcher.
function readCandidateDocuments(input: unknown): SourceSyncCandidateDocument[] {
  const parsed = syncSourceChangesGeneratePlanInputSchema.safeParse(input);
  return parsed.success ? parsed.data.candidateDocuments : [];
}

export async function listRuns(ctx: AppContext, limit: number): Promise<SourceSyncRun[]> {
  return ctx.stores.sourceSync.listRuns(limit);
}

export async function getRun(ctx: AppContext, id: string): Promise<SourceSyncRun | undefined> {
  return ctx.stores.sourceSync.getRun(id);
}

// --- Pure helpers (unit-tested) --------------------------------------------

function primaryChange(changeset: ChangesetChange[]): ChangesetChange {
  return changeset.find((change) => !change.delete && typeof change.content === "string") ?? changeset[0];
}

function sourceSyncProposalInput(run: SourceSyncRun, plan: MaintenancePlan, changeset: ChangesetChange[], job: JobView): ProposalInput {
  const primary = primaryChange(changeset);
  const sourceName = resolveSourceNameFromInput(job.input) ?? resolveSourceNameFallback(run.sourceId);
  const from = run.fromSha?.slice(0, 8) ?? "?";
  const to = run.toSha.slice(0, 8);
  return {
    title: `Sync docs to ${sourceName} changes`,
    targetPath: normalizeRelativePath(primary.path),
    markdown: primary.content ?? "",
    rationale: plan.rationale,
    evidence: [],
    gapSummary: `Source sync: ${sourceName} ${from}..${to}`,
    triggeringQuestionIds: [],
    destinationId: run.destinationId,
    jobId: job.id,
    flowId: run.flowId,
    changeset,
    draftContext: {
      gapSummaries: [`Source sync: ${sourceName} ${from}..${to}`],
      sourceFiles: readChangedSourcePaths(job.input).map((sourcePath) => ({ sourceName, path: sourcePath })),
      evidenceCount: 0,
      openPullRequests: []
    }
  };
}

function resolveSourceNameFromInput(input: unknown): string | undefined {
  const parsed = syncSourceChangesGeneratePlanInputSchema.safeParse(input);
  return parsed.success ? parsed.data.sourceName : undefined;
}

function resolveSourceNameFallback(sourceId: string): string {
  return sourceId;
}

// The source files that changed, read back from the plan job input for the intent's
// evidence. Best-effort: the input was validated at enqueue, so a parse failure is
// not expected; degrade to an empty list rather than throwing in the completion path.
function readChangedSourcePaths(input: unknown): string[] {
  const parsed = syncSourceChangesGeneratePlanInputSchema.safeParse(input);
  return parsed.success ? parsed.data.changes.map((change) => change.path) : [];
}

// Builds the retrieval query from the changed files: paths plus their diffs,
// truncated so a large commit can't produce an unbounded query.
export function buildRetrievalQuery(changes: SourceFileChange[]): string {
  const query = changes.map((change) => `${change.path}\n${change.diff}`).join("\n\n");
  return query.length > RETRIEVAL_QUERY_MAX_CHARS ? query.slice(0, RETRIEVAL_QUERY_MAX_CHARS) : query;
}

// Collapses ranked sections into the distinct documents they belong to, in rank
// order, capped at `limit`. These are the only documents the model may edit.
export function selectCandidateDocuments(
  ranked: RankedSection[],
  documents: KnowledgeDocument[],
  limit: number
): SourceSyncCandidateDocument[] {
  const byId = new Map(documents.map((document) => [document.id, document]));
  const seen = new Set<string>();
  const candidates: SourceSyncCandidateDocument[] = [];

  for (const { section } of ranked) {
    const document = byId.get(section.documentId);
    if (!document || seen.has(document.id)) {
      continue;
    }
    seen.add(document.id);
    candidates.push({ path: document.path, content: document.content });
    if (candidates.length >= limit) {
      break;
    }
  }

  return candidates;
}

// Keeps only writes that target a candidate document, dropping deletes and any
// path the model invented outside the set it was given.
export function constrainToCandidates(
  changes: ChangesetChange[],
  candidateDocuments: SourceSyncCandidateDocument[]
): ChangesetChange[] {
  const allowed = new Set(candidateDocuments.map((document) => normalizeRelativePath(document.path)));
  return changes.filter((change) => !change.delete && allowed.has(normalizeRelativePath(change.path)));
}

// Flattens a plan's operations into a single de-duplicated changeset. Deletes are
// applied first, then writes, so a path that is both deleted and (re)written ends
// up as a write — a split that reuses the original path stays a write, not a
// delete. Pure: the publication runner mirrors this so it derives the same
// changeset the API validated.
export function changesetFromPlan(plan: MaintenancePlan): ChangesetChange[] {
  const changes = new Map<string, ChangesetChange>();
  for (const operation of plan.operations) {
    for (const deletion of operation.deletes) {
      changes.set(normalizeRelativePath(deletion), { path: deletion, delete: true });
    }
  }
  for (const operation of plan.operations) {
    for (const write of operation.writes) {
      changes.set(normalizeRelativePath(write.path), { path: write.path, content: write.content });
    }
  }
  return [...changes.values()];
}

function toSourceChangeFile(change: SourceFileChange): SourceChangeFile {
  return { path: change.path, status: change.status, diff: change.diff };
}
