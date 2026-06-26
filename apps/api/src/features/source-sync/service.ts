import type {
  ChangesetChange,
  KnowledgeDocument,
  RankedSection,
  RepositoryRef,
  SourceChangeFile,
  SourceChangeSyncJobInput,
  SourceSyncCandidateDocument,
  SourceSyncRun,
  SourceSyncRunTrigger
} from "@magpie/core";
import type { JobView } from "@magpie/jobs";
import {
  publishSourceSyncOutputSchema,
  syncSourceChangesGeneratePlanInputSchema,
  syncSourceChangesGeneratePlanOutputSchema
} from "@magpie/jobs";
import { z } from "zod";
import {
  diffChangedFiles,
  ensureGitCheckout,
  getHeadSha,
  type SourceFileChange
} from "@magpie/git";
import type { ChangeIntent } from "../../scheduling/intent.js";
import { decideReconciliation, openPullRequestSummaries } from "../../scheduling/reconcile-gate.js";
import { sameFlowOpenProposals } from "../../scheduling/flow.js";
import type { AppContext } from "../../context.js";
import { changesetFromPlan } from "../crunch/service.js";
import {
  checkoutRoot,
  defaultDestinationId,
  findRepositoryForDestination,
  selectFlow
} from "../../platform/repositories.js";
import type { ConfiguredKnowledgeRepository } from "../../stores/knowledge-repositories.js";
import { normalizeRelativePath } from "../../platform/paths.js";
import { type AiProviderName } from "../../platform/providers.js";

// How many retrieved sections to consider, and how many distinct documents to
// hand the model as editable candidates. Kept small so the model sees only the
// documents most likely to describe the changed behaviour.
const RETRIEVAL_SECTION_LIMIT = 12;
const CANDIDATE_DOCUMENT_LIMIT = 6;
// The retrieval query (changed paths + diffs) is capped so a large commit can't
// blow up the embedding/keyword query.
const RETRIEVAL_QUERY_MAX_CHARS = 6_000;

// Re-gate the flow's deferred runs at the top of each tick: a run deferred because
// its changeset overlapped an open PR is re-checked, and published once the overlap
// has cleared (the blocking PR merged/closed). Still-overlapping runs stay deferred.
// Bounded by the deferred-run count; runs on the existing scheduled cadence.
async function regateDeferredRuns(ctx: AppContext, flowId: string | undefined): Promise<void> {
  for (const run of await ctx.stores.sourceSync.listDeferredRuns(flowId)) {
    if (!run.changeset || run.changeset.length === 0) {
      continue;
    }
    const proposals = await sameFlowOpenProposals(ctx, run.flowId);
    const decision = decideReconciliation(sourceSyncIntent(run, run.changeset), openPullRequestSummaries(proposals));
    if (decision.kind !== "open-new") {
      continue; // still overlapping — leave it deferred for a later tick
    }
    // Gate publication on who won the deferred→completed transition: a concurrent tick
    // (e.g. a manual /source-sync/run racing the scheduled tick) can capture the same
    // deferred run from listDeferredRuns above. completeDeferredRun returns the run only
    // to the caller that effected the transition, so the loser gets undefined and skips —
    // the run is published exactly once.
    const completed = await ctx.stores.sourceSync.completeDeferredRun(run.id);
    if (!completed) {
      continue;
    }
    await enqueuePublication(ctx, run.id);
    console.log(`Source-sync re-gate: deferred run ${run.id} overlap cleared; enqueued publication.`);
  }
}

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

  // Re-gate any runs deferred on a previous tick before reacting to new commits, so
  // a change held behind a now-closed PR is published promptly.
  await regateDeferredRuns(ctx, flowId);

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
      console.warn(`Source-change sync failed for source ${source.id} (flow ${flowId ?? "default"}): ${message}`);
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
    checkoutRoot: checkoutRoot()
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
    console.log(`Source-change sync baselined ${source.id} (flow ${flowId ?? "default"}) at ${headSha.slice(0, 8)}.`);
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
    console.log(
      `Source-change sync for ${source.id}: ${changes.length} changed file(s) but no matching knowledge — skipped.`
    );
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
  console.log(
    `Source-change sync for ${source.id}: enqueued plan job ${job.id} over ${changes.length} changed file(s) ` +
      `with ${candidateDocuments.length} candidate(s); run ${run.id} is planning.`
  );
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

  // SCOPE A — one-way reconcile guard. Before publishing, check the changeset's
  // file-set against the same-flow open gap proposals. With no overlap we publish
  // as before; on ANY overlap (the gate's fold OR defer verdict) we defer-and-
  // preserve: the changeset is kept on the run and re-gated on a later tick, never
  // published as a rival. Source-sync's baseline already advanced at enqueue, so the
  // deferred changeset is the sole record of this change — dropping it would lose it.
  //
  // We collapse fold→defer deliberately: a real fold would merge this changeset into
  // the overlapping PR, but source-sync is not (yet) a Proposal, so there is nothing
  // for the LLM proposal-fold to merge into. GOAL — SCOPE B: make a source-sync
  // change a first-class Proposal so the gate is symmetric (gap and source-sync each
  // see the other's PRs) and fold becomes a real LLM changeset merge. See
  // docs/maintenance-redesign.md §6 and the spec at
  // docs/superpowers/specs/2026-06-24-source-sync-through-gate-design.md.
  const proposals = await sameFlowOpenProposals(ctx, run.flowId);
  const intent = sourceSyncIntent(run, changeset, readChangedSourcePaths(job.input));
  const decision = decideReconciliation(intent, openPullRequestSummaries(proposals));

  if (decision.kind === "open-new") {
    await ctx.stores.sourceSync.completeRun(run.id, parsed.data, changeset);
    // Git now leaves the API: enqueue publication (fire-and-forget) after the
    // repository pre-flight, mirroring publish_crunch. The watcher executes git.
    await enqueuePublication(ctx, run.id);
    return;
  }

  await ctx.stores.sourceSync.deferRun(run.id, parsed.data, changeset);
  console.log(
    `Source-sync run ${run.id}: changeset overlaps an open PR in flow ${run.flowId ?? "default"} ` +
      `(${decision.kind}); deferred and preserved for re-gate.`
  );
}

// Reads back the candidate documents the plan job was given so the completion handler
// can constrain the plan to them. The input was validated at enqueue, so a parse
// failure is not expected; degrade to an empty set (⇒ empty changeset ⇒ skipped)
// rather than throwing inside the completion dispatcher.
function readCandidateDocuments(input: unknown): SourceSyncCandidateDocument[] {
  const parsed = syncSourceChangesGeneratePlanInputSchema.safeParse(input);
  return parsed.success ? parsed.data.candidateDocuments : [];
}

// Enqueue-only publication: validate the repository pre-flight (no repo / not-git
// ⇒ leave unpublished) then enqueue publish_source_sync. Git execution happens in
// the watcher runner, which fetches the execution context. Mirrors publish_crunch.
async function enqueuePublication(ctx: AppContext, runId: string): Promise<void> {
  const resolved = await resolvePublishRepository(ctx, runId);
  if (!resolved.ok) {
    console.warn(`Source-sync run ${runId}: ${resolved.message ?? resolved.code}; left unpublished.`);
    return;
  }
  const job = await ctx.jobs.create("publish_source_sync", { runId });
  console.log(`Enqueued publish_source_sync job ${job.id} for source-sync run ${runId}`);
}

type SourceSyncPublishValidationError = {
  ok: false;
  status: 404 | 409;
  code:
    | "source_sync_run_not_found"
    | "source_sync_run_not_publishable"
    | "source_sync_run_empty_changeset"
    | "source_sync_repository_not_found"
    | "source_sync_repository_not_git";
  message?: string;
};

// Shared pre-flight for the publish enqueue path and the execution-context
// endpoint: a run is publishable only if it completed with a non-empty persisted
// changeset and its destination maps to a Git checkout. Mirrors crunch's
// resolvePublishRepository so an invalid publish fails fast with the same status.
async function resolvePublishRepository(
  ctx: AppContext,
  runId: string
): Promise<{ ok: true; run: SourceSyncRun; repository: RepositoryRef } | SourceSyncPublishValidationError> {
  const run = await ctx.stores.sourceSync.getRun(runId);
  if (!run) {
    return { ok: false, status: 404, code: "source_sync_run_not_found" };
  }
  if (run.status !== "completed" || !run.changeset) {
    return {
      ok: false,
      status: 409,
      code: "source_sync_run_not_publishable",
      message: "Only completed source-sync runs with a changeset can be published."
    };
  }
  if (run.changeset.length === 0) {
    return {
      ok: false,
      status: 409,
      code: "source_sync_run_empty_changeset",
      message: "This source-sync run does not change any files."
    };
  }

  const repository = await findRepositoryForDestination(ctx.repositoryDeps(), run.destinationId);
  if (!repository) {
    return {
      ok: false,
      status: 409,
      code: "source_sync_repository_not_found",
      message: "No indexed Git repository matches this source-sync run's destination."
    };
  }
  if (repository.git?.scope === "not-git" || !repository.git?.workTreeRoot) {
    return {
      ok: false,
      status: 409,
      code: "source_sync_repository_not_git",
      message: "The matched repository is not a Git checkout."
    };
  }

  return { ok: true, run, repository };
}

type ExecutionContextRepository = Pick<RepositoryRef, "id" | "localPath" | "remoteUrl" | "defaultBranch" | "git">;

// The non-generative, credential-free view the watcher's publish_source_sync
// runner fetches before executing git: the run (with its persisted changeset), the
// resolved source name for the commit title, and exactly the repository fields the
// runner needs. Runs the same pre-flight as the enqueue path, so it returns the
// same 404/409 conditions.
export async function getRunExecutionContext(
  ctx: AppContext,
  runId: string
): Promise<
  | { ok: true; run: SourceSyncRun; sourceName: string; repository: ExecutionContextRepository }
  | SourceSyncPublishValidationError
> {
  const resolved = await resolvePublishRepository(ctx, runId);
  if (!resolved.ok) {
    return resolved;
  }
  const { id, localPath, remoteUrl, defaultBranch, git } = resolved.repository;
  return {
    ok: true,
    run: resolved.run,
    sourceName: resolveSourceName(ctx, resolved.run.sourceId),
    repository: { id, localPath, remoteUrl, defaultBranch, git }
  };
}

// Looks up the configured source's human name for the commit title, falling back
// to the source id when the source is no longer configured.
function resolveSourceName(ctx: AppContext, sourceId: string): string {
  const source = ctx.repositoryDeps().knowledgeConfig.sources.find((candidate) => candidate.id === sourceId);
  return source?.name ?? sourceId;
}

export async function listRuns(ctx: AppContext, limit: number): Promise<SourceSyncRun[]> {
  return ctx.stores.sourceSync.listRuns(limit);
}

export async function getRun(ctx: AppContext, id: string): Promise<SourceSyncRun | undefined> {
  return ctx.stores.sourceSync.getRun(id);
}

type PublishSourceSyncJobOutput = z.infer<typeof publishSourceSyncOutputSchema>;

// Completion handler for publish_source_sync jobs: records the validated git
// publication the watcher performed (branch, commit, optional remote url) onto the
// linked run. Idempotent by runId — a run that already carries a publication is
// left untouched, so re-completing the same job never double-applies or regresses
// the recorded metadata. Source-sync raises no PR. Mirrors the crunch handler.
export async function recordSourceSyncPublicationFromCompletedJob(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<SourceSyncRun | undefined> {
  if (!job || job.type !== "publish_source_sync") {
    return undefined;
  }
  const parsed = publishSourceSyncOutputSchema.safeParse(output);
  if (!parsed.success) {
    return undefined;
  }
  const result: PublishSourceSyncJobOutput = parsed.data;

  const existing = await ctx.stores.sourceSync.getRun(result.runId);
  if (!existing) {
    return undefined;
  }
  if (existing.publication) {
    return existing;
  }

  return ctx.stores.sourceSync.recordRunPublication(result.runId, {
    provider: "local-git",
    branchName: result.branchName,
    commitSha: result.commitSha,
    remoteUrl: result.remoteUrl,
    publishedAt: result.publishedAt
  });
}

// --- Pure helpers (unit-tested) --------------------------------------------

// Builds the source-sync change intent for the gate. decideReconciliation consumes
// only `targets`; `evidence` and `rationale` are populated best-effort for logging
// and the future Scope B fold. Targets are normalised to match how Proposal.targetPath
// is stored, since the gate compares file-sets by exact string match.
function sourceSyncIntent(run: SourceSyncRun, changeset: ChangesetChange[], evidence: string[] = []): ChangeIntent {
  return {
    lens: "source-sync",
    flowId: run.flowId,
    targets: changeset.map((change) => normalizeRelativePath(change.path)),
    evidence,
    rationale: `source-sync ${run.sourceId} ${run.fromSha ?? "?"}..${run.toSha}`
  };
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

function toSourceChangeFile(change: SourceFileChange): SourceChangeFile {
  return { path: change.path, status: change.status, diff: change.diff };
}
