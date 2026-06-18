import type {
  AiJob,
  AiJobType,
  AnswerQuestionJobInput,
  AnswerQuestionJobOutput
} from "@magpie/core";
import type { AppContext } from "../../context.js";
import * as proposalsService from "../proposals/service.js";
import * as crunchService from "../crunch/service.js";

export async function createJob(ctx: AppContext, type: AiJobType, input: unknown): Promise<AiJob> {
  return ctx.stores.aiJobs.enqueue(type, input ?? {});
}

export async function claimJob(
  ctx: AppContext,
  workerName: string,
  acceptedTypes: AiJobType[]
): Promise<AiJob | undefined> {
  return ctx.stores.aiJobs.claimNext(workerName, acceptedTypes);
}

export async function getJob(ctx: AppContext, id: string): Promise<AiJob | undefined> {
  return ctx.stores.aiJobs.get(id);
}

export async function listJobs(ctx: AppContext): Promise<AiJob[]> {
  return ctx.stores.aiJobs.list();
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
): Promise<
  | { ok: false; code: "job_not_found" }
  | { ok: false; code: "invalid_output" }
  | { ok: true; job: AiJob | undefined }
> {
  const existingJob = await ctx.stores.aiJobs.get(jobId);
  if (!existingJob) {
    return { ok: false, code: "job_not_found" };
  }

  // Worker output is untrusted: it must be an object, and for job types that
  // feed a downstream store (answers, proposals, crunch plans) it must match
  // the expected shape. Otherwise we'd silently mark the job complete with
  // garbage that the side-effect handlers quietly skip.
  if (!isPlainObject(output) || !outputMatchesJobType(existingJob.type, output)) {
    return { ok: false, code: "invalid_output" };
  }

  await ctx.stores.aiJobs.complete(jobId, output);
  await updateQuestionLogFromCompletedJob(ctx, existingJob, output);
  await proposalsService.createProposalFromCompletedJob(ctx, existingJob, output);
  await crunchService.attachCrunchPlanFromCompletedJob(ctx, existingJob, output);
  return { ok: true, job: await ctx.stores.aiJobs.get(jobId) };
}

export async function updateQuestionLogFromCompletedJob(
  ctx: AppContext,
  job: AiJob | undefined,
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
    chatProvider: typeof input.provider === "string" ? input.provider : (job.claimedBy ?? "watcher")
  });
}

// Marks a job failed and preserves the original crunch side-effect: when the
// failing job is a crunch_knowledge_base job, its associated run is failed too.
// The two stores keep their distinct fallback messages from the original handler.
export async function failJob(
  ctx: AppContext,
  jobId: string,
  errorMessage: string | undefined
): Promise<AiJob | undefined> {
  const failingJob = await ctx.stores.aiJobs.get(jobId);
  await ctx.stores.aiJobs.fail(jobId, errorMessage ?? "Unknown watcher failure");
  if (failingJob?.type === "crunch_knowledge_base") {
    const run = await ctx.stores.crunchRuns.getRunByJobId(jobId);
    if (run) {
      await ctx.stores.crunchRuns.failRun(run.id, errorMessage ?? "Crunch job failed");
    }
  }
  return ctx.stores.aiJobs.get(jobId);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Validate completion output against the job type, reusing the same guards the
// side-effect handlers rely on. Job types with no downstream consumer accept any
// object payload.
function outputMatchesJobType(type: AiJobType, output: Record<string, unknown>): boolean {
  switch (type) {
    case "answer_question":
      return isAnswerQuestionJobOutput(output);
    case "draft_markdown_proposal":
      return proposalsService.isDraftMarkdownProposalJobOutput(output);
    case "crunch_knowledge_base":
      return crunchService.isCrunchPlan(output);
    default:
      return true;
  }
}

export function isAiJobType(value: unknown): value is AiJobType {
  return (
    value === "answer_question" ||
    value === "summarize_gap" ||
    value === "draft_markdown_proposal" ||
    value === "detect_contradiction" ||
    value === "suggest_consolidation" ||
    value === "crunch_knowledge_base"
  );
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
