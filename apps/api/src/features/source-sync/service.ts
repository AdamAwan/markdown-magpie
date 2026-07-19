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
import { syncSourceChangesGeneratePlanInputSchema, syncSourceChangesGeneratePlanOutputSchema } from "@magpie/jobs";
import { buildGitAuthEnv, diffChangedFiles, ensureGitCheckout, getHeadSha, type SourceFileChange } from "@magpie/git";
import type { AppContext } from "../../context.js";
import { defaultDestinationId, selectFlow } from "../../platform/repositories.js";
import type { ConfiguredKnowledgeRepository } from "../../stores/knowledge-repositories.js";
import { normalizeRelativePath } from "../../platform/paths.js";
import { type AiProviderName } from "../../platform/providers.js";
import { createFanoutBudget, type FanoutBudget } from "../../platform/maintenance-fanout.js";
import type { ProposalInput } from "../../stores/proposal-store.js";
import * as foldService from "../../scheduling/fold.js";
import { logger } from "../../logger.js";
import { flagAdvisoryDraft } from "../proposals/register-check.js";

// How many retrieved sections to consider, and how many distinct documents to
// hand the model as editable candidates. Kept small so the model sees only the
// documents most likely to describe the changed behaviour.
const RETRIEVAL_SECTION_LIMIT = 12;
const CANDIDATE_DOCUMENT_LIMIT = 6;
// The retrieval query (changed paths + diffs) is capped so a large commit can't
// blow up the embedding/keyword query.
const RETRIEVAL_QUERY_MAX_CHARS = 6_000;
// The maximum number of changed files materialized downstream (into the retrieval
// query and the AI plan job input). A pathological commit (a vendored-dependency
// bump, a generated-code refresh, a mass reformat) can touch thousands of files,
// each carrying a per-file patch capped at 8000 chars — without a cap the job input
// alone could be tens of megabytes (e.g. 2000 files × 8KB ≈ 16MB). Beyond the first
// N files the marginal retrieval/planning value is near zero, so we deterministically
// keep the first N (in name-status order) and still record the TRUE total on the run,
// so the truncation is visible and nothing is silently dropped without a trace.
// Configurable for repos whose commits legitimately span many files. Read per call
// (not memoized at module load) so the limit can be tuned via env without a restart.
const SOURCE_SYNC_MAX_CHANGED_FILES_DEFAULT = 1_000;

function maxChangedFiles(): number {
  return positiveIntFromEnv("SOURCE_SYNC_MAX_CHANGED_FILES", SOURCE_SYNC_MAX_CHANGED_FILES_DEFAULT);
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

  const sourceIds = flow ? flow.sourceIds : deps.knowledgeConfig.sources.map((source) => source.id);
  const sources = sourceIds
    .map((id) => deps.knowledgeConfig.sources.find((source) => source.id === id))
    .filter(
      (source): source is ConfiguredKnowledgeRepository =>
        Boolean(source) && source!.kind === "git" && Boolean(source!.url)
    );

  // One fan-out budget for the whole tick: every source's plan-generation enqueue
  // (metered AI) admits through it, so a many-source flow can't fan out past the
  // per-tick budget or the global non-interactive ceiling (#288b).
  const budget = createFanoutBudget(ctx, "source_change_sync", flowId);
  const runs: SourceSyncRun[] = [];
  for (const source of sources) {
    try {
      const run = await syncGitSource(ctx, { flowId, destinationId, source, trigger: options.trigger, budget });
      if (run) {
        runs.push(run);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "source sync failed";
      logger.warn({ sourceId: source.id, flowId: flowId ?? "default", err: message }, "source-change sync failed");
    }
  }
  budget.finish();

  return runs;
}

async function syncGitSource(
  ctx: AppContext,
  args: {
    flowId: string | undefined;
    destinationId: string | undefined;
    source: ConfiguredKnowledgeRepository;
    trigger: SourceSyncRunTrigger;
    budget: FanoutBudget;
  }
): Promise<SourceSyncRun | undefined> {
  const { flowId, destinationId, source, trigger, budget } = args;
  const store = ctx.stores.sourceSync;

  const checkout = await ensureGitCheckout({
    id: source.id,
    url: source.url!,
    branch: source.branch,
    checkoutRoot: ctx.knowledgeConfig.checkoutRoot,
    ...(source.tokenEnv ? { tokenEnv: source.tokenEnv } : {})
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
    logger.info(
      { sourceId: source.id, flowId: flowId ?? "default", sha: headSha.slice(0, 8) },
      "source-change sync baselined"
    );
    return undefined;
  }

  if (previous.lastSha === headSha) {
    return undefined; // No new commits.
  }

  const maxFiles = maxChangedFiles();
  const diff = await diffChangedFiles(checkout.localPath, previous.lastSha, headSha, {
    subpath: source.subpath,
    // Only build patch strings for the first N files (the true total still comes
    // back cheaply), bounding both git's diff output and our in-memory footprint
    // for a pathological commit.
    maxFiles,
    // With a blobless partial clone, diffing last_sha..HEAD lazily fetches the OLD
    // blobs of changed files from origin; thread the same auth the checkout used so
    // private sources don't break (and a fetch failure surfaces as an error).
    authEnv: buildGitAuthEnv(source.url!, source.tokenEnv)
  });
  // The TRUE number of files the commit touched (recorded on the run so nothing is
  // silently lost), and the (possibly truncated) subset we actually materialize and
  // hand downstream to retrieval + the plan job.
  const totalChangedFileCount = diff.totalCount;
  // Strip NUL bytes (0x00) out of every changed-file patch before the content is used
  // anywhere downstream. This matters most for the plan-job input, which pg-boss stores
  // as JSONB: Postgres rejects any json/jsonb string containing a NUL with "unsupported
  // Unicode escape sequence", so the INSERT fails at job creation — before the baseline
  // advances — and the next tick re-diffs the same commit and fails identically, an
  // unbounded wedge (issue #131). A NUL legitimately reaches a *text* diff because git's
  // binary heuristic only scans a file's first ~8 KB, so a NUL past that offset is not
  // detected as binary. It is control garbage with no value to retrieval or the model,
  // so dropping it is loss-free and keeps one poisoned file from wedging the whole source.
  const changes = sanitizeChangeDiffs(diff.changes, { sourceId: source.id, flowId });
  if (totalChangedFileCount === 0) {
    // Commits landed but nothing inside the watched subpath changed.
    await store.setState(flowId, source.id, headSha);
    return undefined;
  }

  const changedFilesTruncated = totalChangedFileCount > changes.length;
  if (changedFilesTruncated) {
    // No silent data loss: the run still records the true total via changedFileCount
    // below, the job input carries an explicit truncation flag, and this prominent
    // warning names both the true total and how many we kept so the truncation is
    // operator-visible.
    logger.warn(
      {
        sourceId: source.id,
        flowId: flowId ?? "default",
        totalChangedFiles: totalChangedFileCount,
        includedChangedFiles: changes.length,
        maxChangedFiles: maxFiles
      },
      "source-change sync: commit changed more files than the cap — only the first N are materialized downstream"
    );
  }

  const candidateDocuments = selectCandidateDocuments(
    await ctx.stores.knowledgeIndex.search(
      buildRetrievalQuery(changes),
      RETRIEVAL_SECTION_LIMIT,
      destinationId ? [destinationId] : undefined
    ),
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
      changedFileCount: totalChangedFileCount,
      candidateCount: 0
    });
    await store.setState(flowId, source.id, headSha);
    logger.info(
      { sourceId: source.id, changedFiles: totalChangedFileCount },
      "source-change sync: changed files but no matching knowledge — skipped"
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
    // The true number of files the commit touched and whether `changes` was capped,
    // so the model prompt (and anything reading the job input) knows it is seeing a
    // representative subset rather than the whole commit.
    totalChangedFileCount,
    changedFilesTruncated,
    candidateDocuments,
    expectedOutput: "maintenance_plan",
    provider: ctx.config.get().aiProvider
  } satisfies SourceChangeSyncJobInput & { provider: AiProviderName };

  // Admit the plan-generation enqueue through the tick's fan-out budget (#288b).
  // A shed DEFERS this source: no run is recorded and the baseline is NOT advanced,
  // so the next tick re-diffs the same commit and retries — the sheddable,
  // re-enterable deferral the patrols/reconciler use.
  const admission = await budget.admit("sync_source_changes_generate_plan", input);
  if (!admission.ok) {
    logger.info(
      { sourceId: source.id, flowId: flowId ?? "default", reason: admission.reason },
      "source-change sync: plan job deferred by maintenance fan-out budget; baseline held, will retry next tick"
    );
    return undefined;
  }
  const job = admission.job;
  const run = await store.createRun({
    flowId,
    destinationId,
    sourceId: source.id,
    trigger,
    status: "running",
    jobId: job.id,
    fromSha: previous.lastSha,
    toSha: headSha,
    changedFileCount: totalChangedFileCount,
    candidateCount: candidateDocuments.length
  });
  await store.setState(flowId, source.id, headSha);
  logger.info(
    {
      sourceId: source.id,
      jobId: job.id,
      changedFiles: totalChangedFileCount,
      includedChangedFiles: changes.length,
      candidates: candidateDocuments.length,
      runId: run.id
    },
    "source-change sync: enqueued plan job"
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

  const completed = await ctx.stores.sourceSync.completeRun(run.id, parsed.data, changeset);
  if (!completed) {
    return;
  }
  const existing = await ctx.stores.proposals.getByJobId(job.id);
  const proposal =
    existing ??
    (await ctx.stores.proposals.create(
      flagAdvisoryDraft(sourceSyncProposalInput(completed, parsed.data, changeset, job), {
        jobId: job.id,
        jobType: job.type
      })
    ));
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

function sourceSyncProposalInput(
  run: SourceSyncRun,
  plan: MaintenancePlan,
  changeset: ChangesetChange[],
  job: JobView
): ProposalInput {
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
    // Sanitize the document content too: it is the other file-derived string that lands
    // in the JSONB plan-job input, so a NUL byte here (a KB doc that somehow carries one)
    // would wedge job creation exactly as a poisoned diff would. See stripNulBytes.
    candidates.push({ path: document.path, content: stripNulBytes(document.content) });
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

// A single NUL byte (0x00), built via char code to keep this source file plain ASCII.
const NUL = String.fromCharCode(0);

// Removes NUL bytes (0x00) from a string. Postgres json/jsonb forbids them, so any
// file-derived text that reaches a JSONB-backed job input must pass through here first.
// Returns the input unchanged (no allocation) when there is nothing to strip.
export function stripNulBytes(text: string): string {
  return text.includes(NUL) ? text.split(NUL).join("") : text;
}

// Strips NUL bytes out of each change's patch text so the content is safe to embed in
// the retrieval query and, critically, to persist in the JSONB plan-job input. Warns,
// naming the affected paths, so a near-binary file that slipped past git's text
// detection is operator-visible rather than silently mangled. See stripNulBytes / #131.
function sanitizeChangeDiffs(
  changes: SourceFileChange[],
  context: { sourceId: string; flowId: string | undefined }
): SourceFileChange[] {
  const strippedPaths: string[] = [];
  const sanitized = changes.map((change) => {
    if (!change.diff.includes(NUL)) {
      return change;
    }
    strippedPaths.push(change.path);
    return { ...change, diff: stripNulBytes(change.diff) };
  });
  if (strippedPaths.length > 0) {
    logger.warn(
      { sourceId: context.sourceId, flowId: context.flowId ?? "default", paths: strippedPaths },
      "source-change sync: stripped NUL bytes from changed-file patches (near-binary content)"
    );
  }
  return sanitized;
}
