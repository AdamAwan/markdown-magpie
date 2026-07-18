import type { AiUsage, AnswerQuestionJobInput, AnswerQuestionJobOutput } from "@magpie/core";
import { z } from "zod";
import { logger } from "../../logger.js";
import type { JobCapability, JobError, JobType, JobView } from "@magpie/jobs";
import { isRepairableJobType, jobDefinition } from "@magpie/jobs";
import type { AppContext } from "../../context.js";
import { HttpError } from "../../http/errors.js";
import type { JobListFilters } from "../../jobs/broker.js";
import type { WatcherTouch } from "../../stores/watcher-registry-store.js";
import { refreshFlowSnapshotOutputSchema } from "@magpie/jobs";
import * as proposalsService from "../proposals/service.js";
import * as seedService from "../seed/service.js";
import * as questionnairesService from "../questionnaires/service.js";
import * as sourceSyncService from "../source-sync/service.js";
import * as sourceMapService from "../source-map/service.js";
import * as snapshotsService from "../snapshots/service.js";
import { applyPullRequestTransition } from "../../scheduling/gap-reconciler.js";
import * as foldService from "../../scheduling/fold.js";
import { snapshotRoot } from "../../platform/repositories.js";
import type { FanoutBudget } from "../../platform/maintenance-fanout.js";

// Thrown by runJobToCompletion when the maintenance fan-out budget/admission
// sheds the create it was about to make (#288b). Both bounded-wait callers
// (requestReshape, defaultVerifyDocument) already treat a throw as "skip this
// run", so a shed simply defers the unit of work to a later tick. Never thrown on
// a reuseKey hit — reusing an in-flight job spends no budget/capacity.
export class MaintenanceShedError extends Error {
  constructor(
    readonly jobType: JobType,
    readonly reason: "budget_exhausted" | "capacity"
  ) {
    super(`maintenance fan-out shed ${jobType} (${reason})`);
    this.name = "MaintenanceShedError";
  }
}

// answer_question (live /api/ask) and answer_question_batch (the questionnaire
// drip, #288c) share the IDENTICAL answer contract. Everything that routes an
// answer for questionnaire/question-log purposes — the question-log writeback,
// the questionnaire completion/failure hooks, and the repaired-output citation
// guard — treats them alike; the question log's purpose / the item lookup by
// questionLogId is the real discriminator. Accepting both also drains any legacy
// answer_question questionnaire jobs still in flight across a deploy window. The
// live-ask-only paths (ask/gap-closure re-ask enqueue) stay narrow on purpose.
function isAnswerJobType(type: JobType): boolean {
  return type === "answer_question" || type === "answer_question_batch";
}

export async function createJob(ctx: AppContext, type: JobType, input: unknown): Promise<JobView> {
  // Validate the input against the job's own contract at creation (#285). Without
  // this an untrusted `manage:jobs` caller could persist and dispatch a malformed
  // input — e.g. a draft/verify job whose source descriptor carries an `ext::sh`
  // (RCE) or `-`-prefixed (argument-injection) git url, which the source-descriptor
  // schema now rejects. Enforcing the contract here also covers the internal
  // runJobToCompletion enqueue path, whose inputs are already built to the schema.
  const parsed = jobDefinition(type).inputSchema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new HttpError(400, "invalid_job_input", `Job input does not match the ${type} contract`);
  }
  return ctx.jobs.create(type, parsed.data);
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
  if (!job) return undefined;
  // Attach out-of-band repair context (#288d) when this claim is a re-dispatch of
  // a job undergoing one informed repair: the provider runner sees `job.repair`
  // and runs a single-shot reshape instead of the normal job. Mirrors the other
  // JobView decoration patterns (decorateJobs) — a broker read plus a store lookup.
  const repair = await ctx.stores.jobRepairContexts.get(job.id);
  if (repair) {
    return { ...job, repair: { attempt: repair.attempt, priorOutput: repair.priorOutput, issues: repair.issues } };
  }
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
  options: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {}
): Promise<{ terminal: boolean; job: JobView }> {
  const timeoutMs = options.timeoutMs ?? ctx.settings.jobs.waitTimeoutMs;
  const pollMs = options.pollMs ?? ctx.settings.jobs.waitPollMs;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const job = await ctx.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    const terminal = isTerminal(job.state);
    // A fired `signal` (the caller's request was aborted — e.g. the maintenance
    // watcher's verify-closure POST hit its timeout and pg-boss will retry the
    // job) ends the wait like the deadline does: the caller treats a
    // non-terminal view as "skip this run", so the orphaned job is cancelled and
    // no result is acted upon. This is what stops an aborted verifyGapClosure
    // from continuing to run in parallel with its own retry (#195).
    if (terminal || Date.now() >= deadline || options.signal?.aborted) {
      return { terminal, job: (await decorateJobs(ctx, [job]))[0] };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// Job states that are not yet terminal — a job in one of these is either still
// queued, executing, or waiting out a blocked dependency. Mirrors the overlap
// guard in features/scheduled-tasks/service.ts. Exported for callers that need
// their own in-flight dedupe outside runJobToCompletion (e.g. the proposals
// service's one-publish-per-proposal guard).
export const IN_FLIGHT_JOB_STATES: ReadonlySet<JobView["state"]> = new Set(["created", "retry", "active", "blocked"]);

// Creates a job and bounded-waits for it to reach a terminal state, returning the
// terminal JobView (or the last view seen if the deadline elapses first — check
// `.state` for whether it actually completed). Used by API flows that need an AI
// step a watcher executes (e.g. the gap-cluster reshape): the heavy orchestration
// stays in the API, but the only generative step is an enqueued job we wait on.
// The default deadline is tied to the job's own expiry; pass `deadlineMs` (or set
// JOB_RUN_TO_COMPLETION_TIMEOUT_MS) to shorten it, e.g. in tests.
//
// `reuseKey`, when supplied, lets a caller reuse an already in-flight job of the
// same type instead of enqueueing a duplicate: existing in-flight jobs of `type`
// are scanned and the first whose input maps to the same key (via `reuseKey`) is
// waited on instead of creating a new one. This is the cheapest fix for the
// "queue backlog" half of #162: a bounded wait that timed out on a busy queue
// left its job queued (not cancelled — see below) for exactly the scenario where
// the very next caller (e.g. the next cron tick, or a concurrent request for the
// same flow/document) would otherwise pile a duplicate job on top of it.
//
// On timeout (the deadline elapses before the job reaches a terminal state), the
// job is cancelled rather than left to run unread — see cancelOrphanedJob for why
// that is safe even when a watcher has already claimed it. Passing `signal` makes
// an aborted caller (e.g. a maintenance watcher's POST that hit its own timeout)
// end the bounded wait the same way — the orphaned job is cancelled and the
// non-terminal view returned — so the caller can unwind instead of running on in
// parallel with the retry that abort triggered (#195).
// `admission`, when supplied, routes any NEW job creation through the maintenance
// fan-out budget (#288b): a reuseKey hit is returned untouched (reuse spends no
// budget/capacity), but a genuine create must be admitted first — a shed throws
// MaintenanceShedError, which the caller catches as "skip this run".
export async function runJobToCompletion(
  ctx: AppContext,
  type: JobType,
  input: unknown,
  options: {
    deadlineMs?: number;
    pollMs?: number;
    reuseKey?: (input: unknown) => string;
    signal?: AbortSignal;
    admission?: { budget: FanoutBudget };
  } = {}
): Promise<JobView> {
  const job = await acquireJob(ctx, type, input, options.reuseKey, options.admission);
  const deadlineMs =
    options.deadlineMs ??
    ctx.settings.jobs.runToCompletionTimeoutMs ??
    jobDefinition(type).policy.expireInSeconds * 1000;
  const pollMs = options.pollMs ?? ctx.settings.jobs.waitPollMs;
  const { terminal, job: view } = await waitForJob(ctx, job.id, {
    timeoutMs: deadlineMs,
    pollMs,
    signal: options.signal
  });
  return terminal ? view : cancelOrphanedJob(ctx, job.id, view);
}

// Finds an in-flight job of `type` whose input maps to the same `reuseKey` as the
// requested `input`, or creates a fresh job when none exists (or no `reuseKey` was
// given). Scoped to `type` the same way isTaskRunning is in scheduled-tasks, just
// returning the match instead of a boolean.
async function acquireJob(
  ctx: AppContext,
  type: JobType,
  input: unknown,
  reuseKey?: (input: unknown) => string,
  admission?: { budget: FanoutBudget }
): Promise<JobView> {
  if (reuseKey) {
    const key = reuseKey(input);
    const { jobs } = await ctx.jobs.list({ type, limit: 200 });
    const existing = jobs.find(
      (candidate) => IN_FLIGHT_JOB_STATES.has(candidate.state) && reuseKey(candidate.input) === key
    );
    // Reuse spends NO budget/capacity: an in-flight job already holds its slot, so
    // waiting on it must never re-charge admission (#288b).
    if (existing) return existing;
  }
  // No reusable job — this is a genuine create. Under a fan-out budget it must be
  // admitted first; a shed throws MaintenanceShedError (the caller skips this run).
  if (admission) {
    const result = await admission.budget.admit(type, input);
    if (!result.ok) {
      throw new MaintenanceShedError(type, result.reason);
    }
    return result.job;
  }
  return createJob(ctx, type, input);
}

// The bounded wait gave up before the job reached a terminal state: the caller is
// about to treat this attempt as "skip this run", so nothing will ever read this
// job's output once it does complete. Cancelling closes both halves of #162's
// waste: a job still sitting in the queue is never claimed by a late watcher that
// would otherwise run the full (paid-for) generation for an answer nobody reads,
// and a job a watcher already claimed and is mid-flight gets its eventual
// completeJob() call rejected via the existing `job_cancelled` guard rather than
// having its output silently discarded after paying for the generation.
//
// This is race-safe against a concurrent completion/failure without any special
// handling: pg-boss's cancel only updates rows still in a non-terminal state
// (`state < 'completed'`), so if the job finished between our timeout and this
// call, cancel is a no-op and the refetch inside cancelJob returns the job's real
// terminal state instead. Cancelling a job a watcher already claimed (`active`)
// is deliberate, not a bug: pg-boss has no way to interrupt a watcher mid-flight,
// so the goal here is only to make sure the eventual output is never acted upon.
async function cancelOrphanedJob(ctx: AppContext, jobId: string, lastSeen: JobView): Promise<JobView> {
  try {
    return await cancelJob(ctx, jobId);
  } catch (error) {
    // Cancellation failing (e.g. the job vanished) must not throw out of
    // runJobToCompletion — callers already treat a non-"completed" view as "skip
    // this run"; fall back to the last view we saw and just log it.
    logger.warn(
      { jobId, err: error instanceof Error ? error.message : String(error) },
      "runJobToCompletion: failed to cancel orphaned job after bounded-wait timeout"
    );
    return lastSeen;
  }
}

// THE COMPLETION DISPATCHER. Looks up the existing job (404 if missing),
// validates and PERSISTS the output first, then fans out to the side-effect
// handlers in a fixed order — question log update, proposal creation, proposal
// publication, source-sync plan attachment, then source-sync publication.
//
// Ordering rationale (#161): persisting completion before running any side
// effect means pg-boss has already moved the job to its terminal `completed`
// state before the fan-out below runs a single line. pg-boss only ever retries
// (and the watcher only ever re-invokes the provider for) a job that has NOT
// reached `completed` — see `failJobsById`'s `state < 'completed'` guard in
// pg-boss, and `complete()`'s `state = 'active'` guard, which makes a repeat
// completion call a safe no-op. So once `ctx.jobs.complete()` below returns, the
// paid-for generation can never be redone by anything in this process, no matter
// what happens next. A side-effect failure must therefore never re-fail the job
// (besides being semantically wrong — the job DID complete — pg-boss silently
// ignores a fail() on an already-completed row anyway): it is logged loudly and
// returned as the `side_effects_failed` outcome, which the route maps to a 500.
// That 500 is what makes transient side-effect failures SELF-HEALING: the
// watcher's complete() retry loop treats a 5xx as retryable and re-POSTs the
// same completion, which lands in the replay branch below and re-runs ONLY the
// side effects — never the generation. Every handler below is idempotent on
// jobId (each store call de-dupes proposals by jobId), so a replay is safe. To
// make that replay possible even though the original `output` argument may not
// be resent, a job already in `completed` state reuses its own persisted
// `{ result, executor }` envelope instead of re-validating (and requiring) a
// fresh `output` body. If the watcher exhausts its retries and falls back to
// fail(), that fail() is a no-op on the completed row — the terminal state is
// still a completed job with the side-effect failure logged, and a later manual
// re-POST can still replay the side effects.
export async function completeJob(
  ctx: AppContext,
  jobId: string,
  output: unknown,
  executor = "watcher",
  // The watcher's summed provider-reported token usage for the run (#241),
  // persisted on the completion envelope beside result/executor. Optional:
  // CLI providers and non-AI jobs report nothing.
  usage?: AiUsage,
  // The provider + configured model that executed the run's AI work, persisted
  // flat on the envelope beside usage so token spend can be priced per model.
  // Optional: non-AI jobs and older watchers report nothing, and a CLI run
  // without an explicit model config reports only the provider.
  identity?: { provider?: string; model?: string }
): Promise<
  | { ok: false; code: "job_not_found" }
  | { ok: false; code: "invalid_output" }
  // A schema-invalid output that was routed to one informed repair instead of
  // terminal-failing (#288d): the SAME job was moved active->retry and will be
  // re-dispatched carrying its repair context. The route maps this to 400 (the
  // watcher treats a deterministic 4xx as final, so pg-boss's retry is the sole
  // re-dispatch).
  | { ok: false; code: "repair_enqueued" }
  | { ok: false; code: "job_cancelled" }
  | { ok: false; code: "side_effects_failed" }
  | { ok: true; job: JobView | undefined }
> {
  const existingJob = await ctx.jobs.get(jobId);
  if (!existingJob) {
    return { ok: false, code: "job_not_found" };
  }
  if (existingJob.state === "cancelled") return { ok: false, code: "job_cancelled" };

  let resultData: unknown;
  if (existingJob.state === "completed") {
    // Replay: the generation and its output are already durably persisted (this
    // is either the watcher retrying a complete() call whose response was lost,
    // or an operator re-driving side effects after a prior failure) — reuse the
    // persisted result rather than re-validating (and requiring) `output`.
    resultData = completedJobResult(existingJob);
    if (resultData === undefined) {
      logger.warn(
        { jobId, jobType: existingJob.type },
        "completed job has no persisted result to replay side effects from"
      );
      return { ok: true, job: existingJob };
    }
  } else {
    const parsed = jobDefinition(existingJob.type).outputSchema.safeParse(output);
    if (!parsed.success) {
      // Schema-invalid output. Either route it to ONE informed repair (a
      // repairable type, repair enabled, no prior repair context) or take the
      // terminal-fail backstop (#288d) — no more blind paid retries. See
      // decideRepairOrTerminal for the full decision table.
      return handleInvalidOutput(ctx, existingJob, output, parsed.error, executor);
    }
    resultData = parsed.data;
    // Output schemas are z.object, so a valid parse STRIPPED any undeclared keys.
    // Surface the strip (never fail on it) so a watcher shipping fields the job
    // contract doesn't declare is observable rather than silent (#288d).
    const strippedKeys = strippedOutputKeyPaths(output, resultData);
    if (strippedKeys.length > 0) {
      logger.warn(
        { jobId, jobType: existingJob.type, strippedKeys },
        "watcher output carried undeclared fields stripped to the job contract"
      );
    }
    // Repair-run success handling (#288d): when a repair context exists, this
    // completion is the repaired output. Enforce the per-type safety guard BEFORE
    // persisting completion — a guard failure must terminal-fail, not complete.
    const repairContext = await ctx.stores.jobRepairContexts.get(jobId);
    if (repairContext && !passesRepairSafetyGuard(existingJob.type, repairContext.priorOutput, resultData)) {
      await failJob(
        ctx,
        jobId,
        {
          code: "repair_guard_failed",
          message: "Repaired output failed the per-type safety guard",
          category: "validation",
          ...(executor ? { executor } : {})
        },
        { terminal: true }
      );
      await ctx.stores.jobRepairContexts.delete(jobId);
      logger.info(
        {
          event: "job_repair",
          decision: "failed",
          jobId,
          jobType: existingJob.type,
          ...(providerOf(existingJob) ? { provider: providerOf(existingJob) } : {}),
          attempt: repairContext.attempt
        },
        "repaired output failed the safety guard; failing terminally"
      );
      return { ok: false, code: "invalid_output" };
    }
    // Persist completion BEFORE the side-effect fan-out below — see the
    // ordering rationale in this function's docstring. `usage` rides the same
    // envelope (not the job's own output) so it can never collide with the
    // job contract's schema-stripping — the Insights AI-usage chart reads it
    // from here (#241). `provider`/`model` ride the envelope the same way, so
    // usage rollups can price token spend per model.
    await ctx.jobs.complete(jobId, {
      result: resultData,
      executor,
      ...(usage ? { usage } : {}),
      ...(identity?.provider ? { provider: identity.provider } : {}),
      ...(identity?.model ? { model: identity.model } : {})
    });
    // The repaired output is valid and safe: delete the context (the "one repair"
    // counter) and emit the success event. Deletion is idempotent, so a later
    // side-effect-failure replay (which re-enters via the completed-state branch)
    // is unaffected.
    if (repairContext) {
      await ctx.stores.jobRepairContexts.delete(jobId);
      logger.info(
        {
          event: "job_repair",
          decision: "succeeded",
          jobId,
          jobType: existingJob.type,
          ...(providerOf(existingJob) ? { provider: providerOf(existingJob) } : {}),
          attempt: repairContext.attempt
        },
        "repaired output passed the job contract; completing normally"
      );
    }
  }

  try {
    await updateQuestionLogFromCompletedJob(ctx, existingJob, resultData);
    // Questionnaire items ride the same answer_question completions: the item
    // lookup by questionLogId inside the handler is the no-op guard for every
    // non-questionnaire ask. Runs inside the replayable side-effect block, so a
    // store failure here rides the 500-replay contract like its neighbours.
    if (isAnswerJobType(existingJob.type) && isAnswerQuestionJobOutput(resultData)) {
      await questionnairesService.handleQuestionnaireAnswerCompletion(ctx, existingJob, resultData);
    }
    const draftedProposal = await proposalsService.createProposalFromCompletedJob(ctx, existingJob, resultData);
    if (draftedProposal) {
      // At-draft fold: best-effort, must never fail the draft completion itself.
      try {
        await foldService.reconcileDraftedProposal(ctx, draftedProposal);
      } catch (error) {
        logger.warn(
          { proposalId: draftedProposal.id, err: error instanceof Error ? error.message : String(error) },
          "fold check for proposal failed"
        );
      }
    }
    const correctiveProposal = await proposalsService.createCorrectiveProposalFromCompletedJob(
      ctx,
      existingJob,
      resultData
    );
    if (correctiveProposal) {
      // Corrective reconcile is best-effort, like the at-draft fold hook: it must
      // never fail the job completion itself.
      try {
        await foldService.reconcileCorrectiveProposal(ctx, correctiveProposal);
      } catch (error) {
        logger.warn(
          { proposalId: correctiveProposal.id, err: error instanceof Error ? error.message : String(error) },
          "corrective reconcile for proposal failed"
        );
      }
    }
    const seedProposal = await proposalsService.createSeedProposalFromCompletedJob(ctx, existingJob, resultData);
    if (seedProposal) {
      // Seed reconcile is best-effort, like the other completion-side hooks: it gates
      // the freshly-authored doc and either self-publishes or folds; never fail completion.
      try {
        await foldService.reconcileSeedProposal(ctx, seedProposal);
      } catch (error) {
        logger.warn(
          { proposalId: seedProposal.id, err: error instanceof Error ? error.message : String(error) },
          "seed reconcile for proposal failed"
        );
      }
    }
    // Outline completions persist a reviewable seed plan (no-op for other job
    // types; a real store failure correctly rides the 500-replay contract below).
    await seedService.createSeedPlanFromCompletedJob(ctx, existingJob, resultData);
    // Revise completions apply the reshaped plan in place (no-op for other job
    // types; a real store failure rides the same 500-replay contract).
    await seedService.reviseSeedPlanFromCompletedJob(ctx, existingJob, resultData);
    const dedupeProposal = await proposalsService.createDedupeProposalFromCompletedJob(ctx, existingJob, resultData);
    if (dedupeProposal) {
      // Dedupe reconcile is best-effort too — it gates the multi-file change and either
      // self-publishes or enqueues the multi-file fold; it must never fail completion.
      try {
        await foldService.reconcileDedupeProposal(ctx, dedupeProposal);
      } catch (error) {
        logger.warn(
          { proposalId: dedupeProposal.id, err: error instanceof Error ? error.message : String(error) },
          "dedupe reconcile for proposal failed"
        );
      }
    }
    const improveProposal = await proposalsService.createImproveProposalFromCompletedJob(ctx, existingJob, resultData);
    if (improveProposal) {
      try {
        await foldService.reconcileImproveProposal(ctx, improveProposal);
      } catch (error) {
        logger.warn(
          { proposalId: improveProposal.id, err: error instanceof Error ? error.message : String(error) },
          "improve reconcile for proposal failed"
        );
      }
    }
    const splitProposal = await proposalsService.createSplitProposalFromCompletedJob(ctx, existingJob, resultData);
    if (splitProposal) {
      // Split reconcile follows the same multi-file, clusterless ownership as dedupe.
      try {
        await foldService.reconcileSplitProposal(ctx, splitProposal);
      } catch (error) {
        logger.warn(
          { proposalId: splitProposal.id, err: error instanceof Error ? error.message : String(error) },
          "split reconcile for proposal failed"
        );
      }
    }
    await foldService.applyFoldFromCompletedJob(ctx, existingJob, resultData);
    await foldService.applyChangesetFoldFromCompletedJob(ctx, existingJob, resultData);
    await proposalsService.recordPublicationFromCompletedJob(ctx, existingJob, resultData);
    await sourceSyncService.attachSourceSyncPlanFromCompletedJob(ctx, existingJob, resultData);
    // Source-map contributions ride source-grounded outputs; applying them is
    // internally best-effort (the service never throws) and idempotent on replay.
    await sourceMapService.applySourceMapUpdatesFromCompletedJob(ctx, existingJob, resultData);
    await handleRefreshFlowSnapshotCompletion(ctx, existingJob, resultData);
    // The watcher is free again the moment it completes a job; reflect that
    // immediately rather than waiting for its next idle claim poll.
    await touchWatcher(ctx, { name: executor, status: "idle" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The job's output is already durably persisted (above), so pg-boss will
    // never redo the generation regardless of what we do here — do NOT fail the
    // job (see this function's docstring). Log loudly and return the distinct
    // side_effects_failed outcome: the route maps it to a 500, the watcher's
    // complete() retry re-POSTs, and the replay branch above re-runs only the
    // side effects from the persisted result.
    logger.error(
      { jobId, jobType: existingJob.type, err: message },
      "job completed but its side effects failed; a retried completion replays only the side effects"
    );
    return { ok: false, code: "side_effects_failed" };
  }
  return { ok: true, job: await ctx.jobs.get(jobId) };
}

// THE REPAIR DECISION (#288d). A schema-invalid watcher output is either routed
// to ONE informed repair or taken straight to the terminal-fail backstop. See
// the interaction table in the issue; this helper encodes it:
//   - repairable type + repair enabled + NO prior context -> persist context,
//     plain fail() -> pg-boss active->retry (one informed repair). NO retryLimit
//     manipulation and NO admission control: the job already holds its capacity
//     slot (sub-item a), so the fail->retry must not re-charge admission.
//   - everything else (non-repairable type, repair disabled, or a repair run that
//     produced invalid output AGAIN — signalled by a prior context row) -> the
//     terminal-fail backstop (failTerminal): terminal `failed` + dead-letter,
//     zero further paid generations. A prior context is deleted so nothing loops.
async function handleInvalidOutput(
  ctx: AppContext,
  job: JobView,
  rawOutput: unknown,
  error: z.ZodError,
  executor: string
): Promise<{ ok: false; code: "invalid_output" | "repair_enqueued" }> {
  const jobId = job.id;
  const provider = providerOf(job);
  const issues = error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message }));
  const priorContext = await ctx.stores.jobRepairContexts.get(jobId);

  const offerRepair = ctx.settings.jobs.repairEnabled && isRepairableJobType(job.type) && !priorContext;
  if (offerRepair) {
    // The counter IS the presence of this row: a repair run always carries it, so
    // a second schema-invalid output falls through to the terminal branch below.
    await ctx.stores.jobRepairContexts.put({ jobId, targetType: job.type, priorOutput: rawOutput, issues, attempt: 1 });
    // Plain fail() only — pg-boss moves the SAME job active->retry (retryCount is
    // bumped at re-claim, not here). Not routed through createIfAdmitted: the job
    // is already in flight and holds the slot the original admission reserved, so
    // re-admitting would double-charge and could 429 mid-repair.
    await ctx.jobs.fail(jobId, {
      code: "invalid_output_repairable",
      message: "Watcher output did not match the job contract; enqueued for one informed repair",
      category: "validation",
      ...(executor ? { executor } : {})
    });
    logger.info(
      {
        event: "job_repair",
        decision: "enqueued",
        jobId,
        jobType: job.type,
        ...(provider ? { provider } : {}),
        attempt: 1,
        issueCount: issues.length
      },
      "schema-invalid output enqueued for one informed repair"
    );
    return { ok: false, code: "repair_enqueued" };
  }

  // Terminal-fail backstop. failJob(terminal) runs failTerminal AND the existing
  // terminal side-effects (fold fallback for fold jobs, questionnaire-item failure
  // for answer_question), which all key on the resulting `failed` state.
  await failJob(
    ctx,
    jobId,
    {
      code: "invalid_output",
      message: "Watcher output did not match the job contract",
      category: "validation",
      ...(executor ? { executor } : {})
    },
    { terminal: true }
  );
  if (priorContext) {
    await ctx.stores.jobRepairContexts.delete(jobId);
    logger.info(
      {
        event: "job_repair",
        decision: "failed",
        jobId,
        jobType: job.type,
        ...(provider ? { provider } : {}),
        attempt: priorContext.attempt,
        issueCount: issues.length
      },
      "repaired output was still schema-invalid; failing terminally"
    );
  }
  return { ok: false, code: "invalid_output" };
}

// The per-type safety guard a repaired output must pass (#288d). For
// the answer contract (answer_question and answer_question_batch, #288c),
// citations are derived in code from retrieved sections and must never be
// fabricated by the model: the repaired output's citation sectionIds must be a
// SUBSET of the prior output's (drop/keep allowed, never add). Any other type has
// no extra guard. A guard failure ⇒ treat as invalid ⇒ terminal-fail.
function passesRepairSafetyGuard(type: JobType, priorOutput: unknown, repairedOutput: unknown): boolean {
  if (!isAnswerJobType(type)) {
    return true;
  }
  const allowed = new Set(citationSectionIds(priorOutput));
  return citationSectionIds(repairedOutput).every((sectionId) => allowed.has(sectionId));
}

function citationSectionIds(output: unknown): string[] {
  if (!isPlainObject(output)) return [];
  const citations = output.citations;
  if (!Array.isArray(citations)) return [];
  return citations.flatMap((citation) =>
    isPlainObject(citation) && typeof citation.sectionId === "string" ? [citation.sectionId] : []
  );
}

// The provider a provider-routed job runs under (input.provider), for the
// structured job_repair event. Undefined for non-provider inputs.
function providerOf(job: JobView): string | undefined {
  return isPlainObject(job.input) && typeof job.input.provider === "string" ? job.input.provider : undefined;
}

// The dotted key paths present in `raw` but absent in `kept` after a z.object
// parse stripped unknown keys (#288d). Walks plain objects recursively; ARRAYS
// ARE TREATED AS LEAVES — element-level strips inside arrays are not reported
// (pairing raw/kept array elements positionally against a possibly-reordered or
// resized array is out of scope; object-level strips are what the warning surfaces).
export function strippedOutputKeyPaths(raw: unknown, kept: unknown, prefix = ""): string[] {
  if (!isPlainObject(raw) || !isPlainObject(kept)) {
    return [];
  }
  const paths: string[] = [];
  for (const [key, rawValue] of Object.entries(raw)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in kept)) {
      paths.push(path);
    } else {
      paths.push(...strippedOutputKeyPaths(rawValue, kept[key], path));
    }
  }
  return paths;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The persisted output of a job completed through this dispatcher: completeJob
// wraps the watcher's validated result in a { result, executor } envelope (see
// ctx.jobs.complete above), and nothing on the JobView read path unwraps it.
const completedJobOutputEnvelopeSchema = z.object({ result: z.unknown() });

// Unwraps a completed job's `{ result, executor }` output envelope, returning
// the validated payload the side-effect handlers expect — mirrors the same
// unwrap the web console and MCP client do for a job's `output` field. Returns
// undefined if the job has no such envelope.
function completedJobResult(job: JobView): unknown {
  const envelope = completedJobOutputEnvelopeSchema.safeParse(job.output);
  return envelope.success ? envelope.data.result : undefined;
}

// Parses a completed job's output against `schema` for API-side consumers of
// runJobToCompletion (the gap reshape, the patrol verify lens, gap-closure
// re-asks). Production outputs arrive in the { result, executor } envelope
// above, so the envelope's `result` is tried first; the raw shape is a fallback
// for brokers that complete without the envelope (e.g. test fakes). Returns
// undefined when neither shape validates. Parsing the raw JobView.output
// directly with an output schema is a bug (#184): it only ever worked against
// raw-completing test fixtures and silently discarded real watcher results.
export function parseCompletedJobOutput<T>(schema: z.ZodType<T>, output: unknown): T | undefined {
  const envelope = completedJobOutputEnvelopeSchema.safeParse(output);
  if (envelope.success) {
    const fromEnvelope = schema.safeParse(envelope.data.result);
    if (fromEnvelope.success) {
      return fromEnvelope.data;
    }
  }
  const raw = schema.safeParse(output);
  return raw.success ? raw.data : undefined;
}

async function updateQuestionLogFromCompletedJob(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<void> {
  if (!job || !isAnswerJobType(job.type) || !isAnswerQuestionJobOutput(output)) {
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
    ...(typeof output.flowId === "string" ? { flowId: output.flowId } : {}),
    // The condensed standalone form of a follow-up (#239), when the watcher rewrote
    // one; persisted so gap candidacy/clustering key off the resolved intent.
    ...(typeof output.standaloneQuestion === "string" ? { standaloneQuestion: output.standaloneQuestion } : {})
  });
}

// Completion handler for refresh_flow_snapshot: the github watcher polled each open
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
async function handleRefreshFlowSnapshotCompletion(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<void> {
  if (!job || job.type !== "refresh_flow_snapshot") {
    return;
  }
  const parsed = refreshFlowSnapshotOutputSchema.safeParse(output);
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
    // A still-open PR the watcher found conflicting has gone stale: its base moved
    // and the merge no longer applies. Auto-regenerate against the fresh base. All
    // guards (approved, retry cap, in-flight, changeset) live in the service; a
    // missing/"unknown"/"mergeable" reading carries no signal and is skipped.
    if (result.mergeable === "conflicting") {
      await proposalsService.maybeRegenerateStaleProposal(ctx, result.proposalId);
    }
  }
  try {
    await snapshotsService.recordSnapshotsFromPullRequestResults(ctx, parsed.data.results);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Name the resolved snapshot root and the env var to set: the common cause is an
    // unwritable default path (relative `.magpie/snapshots` under a read-only workdir),
    // and PR transitions above already succeeded, so only the write needs fixing (#130).
    const snapshotDir = snapshotRoot(ctx.settings);
    logger.warn(
      { err: message, snapshotRoot: snapshotDir },
      `refresh_flow_snapshot: snapshot recording failed after PR transitions were applied ` +
        `(snapshot root ${snapshotDir}). Set MAGPIE_SNAPSHOT_ROOT to a writable, mounted path.`
    );
  }
}

// Marks a job failed. When an enqueue-only planning job fails terminally, its
// linked run is failed too so it does not hang in a "running" state.
//
// `terminal` (#288d) forces the job straight to terminal `failed` + dead-letter
// via failTerminal, skipping any remaining retries — used by the completion
// dispatcher for a reproducible contract violation (schema-invalid output) so it
// burns zero further paid generations. All downstream side-effects below key on
// `failedJob.state === "failed"`, so they fire identically whether the terminal
// state was reached by retry-exhaustion or by this backstop.
export async function failJob(
  ctx: AppContext,
  jobId: string,
  jobError: JobError,
  { terminal = false }: { terminal?: boolean } = {}
): Promise<JobView | undefined> {
  const failingJob = await ctx.jobs.get(jobId);
  const failedJob = terminal ? await ctx.jobs.failTerminal(jobId, jobError) : await ctx.jobs.fail(jobId, jobError);
  // A failure (retryable or terminal) also frees the watcher to poll again.
  if (jobError.executor) {
    await touchWatcher(ctx, { name: jobError.executor, status: "idle" });
  }
  // Source-sync planning is enqueue-only, so a terminally failed plan job fails its
  // linked run too. Only a still-"running" run is failed, so this never regresses a
  // run that already completed.
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
  // A terminally failed answer job that belongs to a questionnaire item marks
  // that item unanswerable (error on the worksheet) and frees its drip slot.
  // Retryable failures are skipped — the job will run again.
  if (failingJob && isAnswerJobType(failingJob.type) && failedJob.state === "failed") {
    await questionnairesService.handleQuestionnaireAnswerFailure(ctx, failingJob, jobError.message);
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
    logger.warn({ err: error instanceof Error ? error.message : String(error) }, "watcher registry update failed");
  }
}
