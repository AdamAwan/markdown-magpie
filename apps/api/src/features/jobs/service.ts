import type { AnswerQuestionJobInput, AnswerQuestionJobOutput } from "@magpie/core";
import type { JobCapability, JobError, JobType, JobView } from "@magpie/jobs";
import { jobDefinition } from "@magpie/jobs";
import type { AppContext } from "../../context.js";
import type { JobListFilters } from "../../jobs/broker.js";
import type { WatcherTouch } from "../../stores/watcher-registry-store.js";
import { refreshPullRequestsOutputSchema } from "@magpie/jobs";
import * as proposalsService from "../proposals/service.js";
import * as crunchService from "../crunch/service.js";
import * as sourceSyncService from "../source-sync/service.js";
import * as snapshotsService from "../snapshots/service.js";
import { applyPullRequestTransition } from "../../scheduling/gap-reconciler.js";
import * as foldService from "../../scheduling/fold.js";

export async function createJob(ctx: AppContext, type: JobType, input: unknown): Promise<JobView> {
  return ctx.jobs.create(type, input ?? {});
}

export async function claimJob(
  ctx: AppContext,
  workerName: string,
  // TODO(Task 4): capability-based claim contract
  capabilities: JobCapability[]
): Promise<JobView | undefined> {
  const job = await ctx.jobs.claim(workerName, capabilities);
  // A claim is the watcher's idle poll: it becomes busy if it got a job, and
  // stays idle otherwise. This is also where capabilities reach the registry.
  await touchWatcher(ctx, {
    name: workerName,
    capabilities,
    status: job ? "busy" : "idle",
    currentJobId: job?.id
  });
  return job;
}

export async function getJob(ctx: AppContext, id: string): Promise<JobView | undefined> {
  const job = await ctx.jobs.get(id);
  return job ? (await decorateJobs(ctx, [job]))[0] : undefined;
}

export async function listJobs(
  ctx: AppContext,
  filters: JobListFilters = {}
): Promise<{ jobs: JobView[]; total: number }> {
  const result = await ctx.jobs.list(filters);
  return { ...result, jobs: await decorateJobs(ctx, result.jobs) };
}

export async function heartbeatJob(ctx: AppContext, id: string, workerName?: string): Promise<JobView> {
  const job = await ctx.jobs.heartbeat(id);
  // A heartbeat only arrives while a watcher is running a job, so it keeps that
  // watcher marked busy on the job it is processing. workerName is absent on
  // legacy/internal callers, which simply don't update the registry.
  if (workerName) {
    await touchWatcher(ctx, { name: workerName, status: "busy", currentJobId: id });
  }
  return job;
}

export async function cancelJob(ctx: AppContext, id: string): Promise<JobView> {
  return ctx.jobs.cancel(id);
}

export async function retryJob(ctx: AppContext, id: string): Promise<JobView> {
  await ctx.stores.jobAcceptances.clear(id);
  const job = await ctx.jobs.retry(id);
  return projectJob(job);
}

export async function acceptFailedJob(ctx: AppContext, id: string): Promise<JobView> {
  const job = await ctx.jobs.get(id);
  if (!job) throw new Error(`Job not found: ${id}`);
  if (job.state !== "failed") throw new Error("Only failed jobs can be accepted");
  const acceptedAt = await ctx.stores.jobAcceptances.accept(id);
  return { ...projectJob(job), acceptedAt };
}

export async function waitForJob(
  ctx: AppContext,
  id: string,
  options: { timeoutMs?: number; pollMs?: number } = {}
): Promise<{ terminal: boolean; job: JobView }> {
  const timeoutMs = options.timeoutMs ?? parsePositiveInt(process.env.JOB_WAIT_TIMEOUT_MS, 25_000);
  const pollMs = options.pollMs ?? parsePositiveInt(process.env.JOB_WAIT_POLL_MS, 250);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const job = await ctx.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    const terminal = isTerminal(job.state);
    if (terminal || Date.now() >= deadline) return { terminal, job: (await decorateJobs(ctx, [job]))[0] };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// Creates a job and bounded-waits for it to reach a terminal state, returning the
// terminal JobView (or the last view seen if the deadline elapses first — check
// `.state` for whether it actually completed). Used by API flows that need an AI
// step a watcher executes (e.g. the gap-cluster reshape): the heavy orchestration
// stays in the API, but the only generative step is an enqueued job we wait on.
// The default deadline is tied to the job's own expiry; pass `deadlineMs` (or set
// JOB_RUN_TO_COMPLETION_TIMEOUT_MS) to shorten it, e.g. in tests.
export async function runJobToCompletion(
  ctx: AppContext,
  type: JobType,
  input: unknown,
  options: { deadlineMs?: number; pollMs?: number } = {}
): Promise<JobView> {
  const job = await createJob(ctx, type, input);
  const deadlineMs =
    options.deadlineMs ??
    parsePositiveInt(process.env.JOB_RUN_TO_COMPLETION_TIMEOUT_MS, jobDefinition(type).policy.expireInSeconds * 1000);
  const pollMs = options.pollMs ?? parsePositiveInt(process.env.JOB_WAIT_POLL_MS, 250);
  const { job: terminal } = await waitForJob(ctx, job.id, { timeoutMs: deadlineMs, pollMs });
  return terminal;
}

// THE COMPLETION DISPATCHER. Replicates the original handleCompleteJob logic:
// look up the existing job (404 if missing), persist completion, then fan out to
// the side-effect handlers in a fixed order — question log update, proposal
// creation, proposal publication, crunch-plan attachment, crunch publication,
// source-sync plan attachment, then source-sync publication. Returns a discriminated outcome so the
// handler maps job_not_found to 404 while keeping its own try/catch for the 500
// job_completion_failed path.
export async function completeJob(
  ctx: AppContext,
  jobId: string,
  output: unknown,
  executor = "watcher"
): Promise<
  | { ok: false; code: "job_not_found" }
  | { ok: false; code: "invalid_output" }
  | { ok: false; code: "job_cancelled" }
  | { ok: true; job: JobView | undefined }
> {
  const existingJob = await ctx.jobs.get(jobId);
  if (!existingJob) {
    return { ok: false, code: "job_not_found" };
  }
  if (existingJob.state === "cancelled") return { ok: false, code: "job_cancelled" };

  const parsed = jobDefinition(existingJob.type).outputSchema.safeParse(output);
  if (!parsed.success) {
    await ctx.jobs.fail(jobId, {
      code: "invalid_output",
      message: "Watcher output did not match the job contract",
      category: "validation"
    });
    // No-ops unless this is a fold job (single-file or multi-file).
    await foldService.enqueueFoldFallback(ctx, existingJob);
    return { ok: false, code: "invalid_output" };
  }

  try {
    await updateQuestionLogFromCompletedJob(ctx, existingJob, parsed.data);
    const draftedProposal = await proposalsService.createProposalFromCompletedJob(ctx, existingJob, parsed.data);
    if (draftedProposal) {
      // At-draft fold: best-effort, must never fail the draft completion itself.
      try {
        await foldService.reconcileDraftedProposal(ctx, draftedProposal);
      } catch (error) {
        console.warn(`Fold check for proposal ${draftedProposal.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const correctiveProposal = await proposalsService.createCorrectiveProposalFromCompletedJob(ctx, existingJob, parsed.data);
    if (correctiveProposal) {
      // Corrective reconcile is best-effort, like the at-draft fold hook: it must
      // never fail the job completion itself.
      try {
        await foldService.reconcileCorrectiveProposal(ctx, correctiveProposal);
      } catch (error) {
        console.warn(`Corrective reconcile for proposal ${correctiveProposal.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const dedupeProposal = await proposalsService.createDedupeProposalFromCompletedJob(ctx, existingJob, parsed.data);
    if (dedupeProposal) {
      // Dedupe reconcile is best-effort too — it gates the multi-file change and either
      // self-publishes or enqueues the multi-file fold; it must never fail completion.
      try {
        await foldService.reconcileDedupeProposal(ctx, dedupeProposal);
      } catch (error) {
        console.warn(`Dedupe reconcile for proposal ${dedupeProposal.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const improveProposal = await proposalsService.createImproveProposalFromCompletedJob(ctx, existingJob, parsed.data);
    if (improveProposal) {
      try {
        await foldService.reconcileImproveProposal(ctx, improveProposal);
      } catch (error) {
        console.warn(`Improve reconcile for proposal ${improveProposal.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const splitProposal = await proposalsService.createSplitProposalFromCompletedJob(ctx, existingJob, parsed.data);
    if (splitProposal) {
      // Split reconcile follows the same multi-file, clusterless ownership as dedupe.
      try {
        await foldService.reconcileSplitProposal(ctx, splitProposal);
      } catch (error) {
        console.warn(`Split reconcile for proposal ${splitProposal.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await foldService.applyFoldFromCompletedJob(ctx, existingJob, parsed.data);
    await foldService.applyChangesetFoldFromCompletedJob(ctx, existingJob, parsed.data);
    await proposalsService.recordPublicationFromCompletedJob(ctx, existingJob, parsed.data);
    await crunchService.attachMaintenancePlanFromCompletedJob(ctx, existingJob, parsed.data);
    await crunchService.recordCrunchPublicationFromCompletedJob(ctx, existingJob, parsed.data);
    await sourceSyncService.attachSourceSyncPlanFromCompletedJob(ctx, existingJob, parsed.data);
    await sourceSyncService.recordSourceSyncPublicationFromCompletedJob(ctx, existingJob, parsed.data);
    await handleRefreshPullRequestsCompletion(ctx, existingJob, parsed.data);
    await ctx.jobs.complete(jobId, { result: parsed.data, executor });
    // The watcher is free again the moment it completes a job; reflect that
    // immediately rather than waiting for its next idle claim poll.
    await touchWatcher(ctx, { name: executor, status: "idle" });
  } catch (error) {
    await ctx.jobs.fail(jobId, {
      code: "completion_failed",
      message: "Job completion side effects failed",
      category: "internal"
    });
    throw error;
  }
  return { ok: true, job: await ctx.jobs.get(jobId) };
}

async function updateQuestionLogFromCompletedJob(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<void> {
  if (!job || job.type !== "answer_question" || !isAnswerQuestionJobOutput(output)) {
    return;
  }

  const input = job.input as Partial<AnswerQuestionJobInput> & { provider?: string };
  if (!input.questionLogId) {
    return;
  }

  const existing = await ctx.stores.questionLogs.get(input.questionLogId);
  if (existing?.answer) return;

  await ctx.stores.questionLogs.updateAnswer(input.questionLogId, {
    answer: output,
    // JobView has no live claimant field; fall back to "watcher"
    chatProvider: typeof input.provider === "string" ? input.provider : "watcher",
    // The watcher routed the question to a flow and retrieved the cited sections;
    // record both. retrievedSectionIds is derived from the output citations by the
    // store. flowId is only set when the watcher actually chose a flow.
    ...(typeof output.flowId === "string" ? { flowId: output.flowId } : {})
  });
}

// Completion handler for refresh_pull_requests: the github watcher polled each open
// PR and reported its merged/closed state. Two side effects follow. First, apply the
// proposal-status transitions the reconciler would otherwise apply from a snapshot,
// via the shared applyPullRequestTransition so the merged→cascade+freeze /
// closed→rejected+freeze behaviour can never drift from the reconciler, and is
// idempotent (the shared function only transitions a still-open proposal) so
// re-completing the same job converges without running a merge cascade twice.
// Second, persist the reported state to the snapshot store — the API holds no GitHub
// token, so this watcher-reported state is the only way PR status (and the gaps and
// proposals captured alongside it) reaches the snapshot the /snapshots page and the
// reconciler's PR-state pass read from.
async function handleRefreshPullRequestsCompletion(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<void> {
  if (!job || job.type !== "refresh_pull_requests") {
    return;
  }
  const parsed = refreshPullRequestsOutputSchema.safeParse(output);
  if (!parsed.success) {
    return;
  }
  for (const result of parsed.data.results) {
    await applyPullRequestTransition(ctx, result.proposalId, { merged: result.merged, state: result.state });
    // Conservative update: only a genuine fresh reading updates the stored decision.
    // A result with no reviewDecision (an undetermined poll) must never clobber a
    // known "approved" back to a touchable value — that would re-open an approved
    // PR to folding, the exact failure this guard prevents.
    if (result.reviewDecision) {
      await ctx.stores.proposals.updateReviewDecision(result.proposalId, result.reviewDecision);
    }
  }
  await snapshotsService.recordSnapshotsFromPullRequestResults(ctx, parsed.data.results);
}

// Marks a job failed and preserves the original crunch side-effect: when the
// failing job is a crunch_knowledge_base job, its associated run is failed too.
// The two stores keep their distinct fallback messages from the original handler.
export async function failJob(ctx: AppContext, jobId: string, jobError: JobError): Promise<JobView | undefined> {
  const failingJob = await ctx.jobs.get(jobId);
  const failedJob = await ctx.jobs.fail(jobId, jobError);
  // A failure (retryable or terminal) also frees the watcher to poll again.
  if (jobError.executor) {
    await touchWatcher(ctx, { name: jobError.executor, status: "idle" });
  }
  if (failingJob?.type === "crunch_knowledge_base" && failedJob.state === "failed") {
    const run = await ctx.stores.crunchRuns.getRunByJobId(jobId);
    if (run) {
      await ctx.stores.crunchRuns.failRun(run.id, jobError.message);
    }
  }
  // Source-sync planning is enqueue-only, so a terminally failed plan job fails its
  // linked run too (mirroring the crunch side-effect above). Only a still-"running"
  // run is failed, so this never regresses a run that already completed.
  if (failingJob?.type === "sync_source_changes_generate_plan" && failedJob.state === "failed") {
    const run = await ctx.stores.sourceSync.getRunByJobId(jobId);
    if (run?.status === "running") {
      await ctx.stores.sourceSync.failRun(run.id, jobError.message);
    }
  }
  if (
    (failingJob?.type === "fold_markdown_proposal" || failingJob?.type === "fold_changeset_proposal") &&
    failedJob.state === "failed"
  ) {
    await foldService.enqueueFoldFallback(ctx, failingJob);
  }
  return failedJob;
}

function isAnswerQuestionJobOutput(value: unknown): value is AnswerQuestionJobOutput {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<AnswerQuestionJobOutput>;
  return (
    typeof candidate.answer === "string" &&
    (candidate.confidence === "high" ||
      candidate.confidence === "medium" ||
      candidate.confidence === "low" ||
      candidate.confidence === "unknown") &&
    Array.isArray(candidate.citations)
  );
}

export function projectJob(job: JobView): JobView {
  return {
    ...job,
    input: redactSecrets(job.input),
    output: redactSecrets(job.output),
    error: redactSecrets(job.error) as JobError | undefined
  };
}

async function decorateJobs(ctx: AppContext, jobs: JobView[]): Promise<JobView[]> {
  const acceptances = await ctx.stores.jobAcceptances.getMany(
    jobs.filter((job) => job.state === "failed").map((job) => job.id)
  );
  return jobs.map((job) => ({ ...projectJob(job), acceptedAt: acceptances.get(job.id) }));
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      /^(apiKey|token|authorization|password)$/i.test(key) ? "[redacted]" : redactSecrets(nested)
    ])
  );
}

function isTerminal(state: JobView["state"]): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

// Updates the connected-watcher registry as a side effect of the job lifecycle.
// Deliberately best-effort: the registry is operator telemetry for the Jobs
// screen, never a source of truth for execution, so a write failure must not
// turn a successful claim/heartbeat/completion into an error for the watcher.
async function touchWatcher(ctx: AppContext, input: WatcherTouch): Promise<void> {
  try {
    await ctx.stores.watchers.touch(input);
  } catch (error) {
    console.warn(`Watcher registry update failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
