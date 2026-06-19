import type {
  AnswerQuestionJobInput,
  AnswerQuestionJobOutput
} from "@magpie/core";
import type { JobCapability, JobError, JobType, JobView } from "@magpie/jobs";
import { isJobType } from "@magpie/jobs";
import type { AppContext } from "../../context.js";
import * as proposalsService from "../proposals/service.js";
import * as crunchService from "../crunch/service.js";

export async function createJob(ctx: AppContext, type: JobType, input: unknown): Promise<JobView> {
  return ctx.jobs.create(type, input ?? {});
}

export async function claimJob(
  ctx: AppContext,
  workerName: string,
  // TODO(Task 4): capability-based claim contract
  capabilities: JobCapability[]
): Promise<JobView | undefined> {
  return ctx.jobs.claim(workerName, capabilities);
}

export async function getJob(ctx: AppContext, id: string): Promise<JobView | undefined> {
  return ctx.jobs.get(id);
}

export async function listJobs(ctx: AppContext): Promise<JobView[]> {
  const result = await ctx.jobs.list({});
  return result.jobs;
}

// THE COMPLETION DISPATCHER. Replicates the original handleCompleteJob logic:
// look up the existing job (404 if missing), persist completion, then fan out to
// the side-effect handlers in a fixed order — question log update, proposal
// creation, then crunch-plan attachment. Returns a discriminated outcome so the
// handler maps job_not_found to 404 while keeping its own try/catch for the 500
// job_completion_failed path.
export async function completeJob(
  ctx: AppContext,
  jobId: string,
  output: unknown
): Promise<{ ok: false; code: "job_not_found" } | { ok: true; job: JobView | undefined }> {
  const existingJob = await ctx.jobs.get(jobId);
  if (!existingJob) {
    return { ok: false, code: "job_not_found" };
  }

  await ctx.jobs.complete(jobId, output ?? {});
  await updateQuestionLogFromCompletedJob(ctx, existingJob, output);
  await proposalsService.createProposalFromCompletedJob(ctx, existingJob, output);
  await crunchService.attachCrunchPlanFromCompletedJob(ctx, existingJob, output);
  return { ok: true, job: await ctx.jobs.get(jobId) };
}

export async function updateQuestionLogFromCompletedJob(
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

  await ctx.stores.questionLogs.updateAnswer(input.questionLogId, {
    answer: output,
    // JobView has no live claimant field; fall back to "watcher"
    chatProvider: typeof input.provider === "string" ? input.provider : "watcher"
  });
}

// Marks a job failed and preserves the original crunch side-effect: when the
// failing job is a crunch_knowledge_base job, its associated run is failed too.
// The two stores keep their distinct fallback messages from the original handler.
export async function failJob(
  ctx: AppContext,
  jobId: string,
  errorMessage: string | undefined
): Promise<JobView | undefined> {
  const failingJob = await ctx.jobs.get(jobId);
  const jobError: JobError = {
    code: "watcher_failure",
    message: errorMessage ?? "Unknown watcher failure",
    category: "internal"
  };
  await ctx.jobs.fail(jobId, jobError);
  if (failingJob?.type === "crunch_knowledge_base") {
    const run = await ctx.stores.crunchRuns.getRunByJobId(jobId);
    if (run) {
      await ctx.stores.crunchRuns.failRun(run.id, errorMessage ?? "Crunch job failed");
    }
  }
  return ctx.jobs.get(jobId);
}

// isAiJobType kept for backwards compatibility with the claim route.
// The claim route still reads acceptedTypes from the request body and translates
// them to capabilities; this guard validates that the incoming values are known
// job types before use.
export { isJobType as isAiJobType };

// TODO(Task 4): capability-based claim contract — transitional bridge from
// accepted job types to capabilities. For now, the claim route accepts
// acceptedTypes and maps them by extracting their provider requirements from
// the job body or defaulting to the "maintenance" capability. Because the
// existing tests pass acceptedTypes as job type strings, we map them through
// a simple heuristic: if it's a known AI provider job type, the caller must
// be capable of any provider (we accept all AI provider capabilities). For
// non-provider jobs, we map directly.
export function jobTypesToCapabilities(acceptedTypes: JobType[]): JobCapability[] {
  // All AI providers that could be needed — this is the broadest bridge.
  // Task 4 will replace this with an explicit capability list from the request.
  const allProviderCapabilities: JobCapability[] = ["openai-compatible", "azure-openai", "codex", "claude"];
  const nonProviderCapabilities: JobCapability[] = ["github", "maintenance"];

  const providerTypes = new Set<JobType>([
    "answer_question",
    "summarize_gap",
    "draft_markdown_proposal",
    "detect_contradiction",
    "suggest_consolidation",
    "crunch_knowledge_base",
    "cluster_gap_candidates"
  ]);
  const githubTypes = new Set<JobType>([
    "refresh_pull_requests",
    "publish_proposal",
    "publish_crunch"
  ]);
  const maintenanceTypes = new Set<JobType>([
    "process_gaps_to_pull_requests",
    "trigger_scheduled_crunch"
  ]);

  const capabilities = new Set<JobCapability>();
  for (const type of acceptedTypes) {
    if (providerTypes.has(type)) {
      for (const cap of allProviderCapabilities) {
        capabilities.add(cap);
      }
    } else if (githubTypes.has(type)) {
      capabilities.add("github");
    } else if (maintenanceTypes.has(type)) {
      capabilities.add("maintenance");
    } else {
      // Unknown type: include all to avoid blocking claim
      for (const cap of [...allProviderCapabilities, ...nonProviderCapabilities]) {
        capabilities.add(cap);
      }
    }
  }

  return [...capabilities];
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
