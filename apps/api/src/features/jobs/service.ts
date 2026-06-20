import type {
  AnswerQuestionJobInput,
  AnswerQuestionJobOutput
} from "@magpie/core";
import type { JobCapability, JobError, JobType, JobView } from "@magpie/jobs";
import { jobDefinition } from "@magpie/jobs";
import type { AppContext } from "../../context.js";
import type { JobListFilters } from "../../jobs/broker.js";
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
  const job = await ctx.jobs.get(id);
  return job ? projectJob(job) : undefined;
}

export async function listJobs(ctx: AppContext, filters: JobListFilters = {}): Promise<{ jobs: JobView[]; total: number }> {
  const result = await ctx.jobs.list(filters);
  return { ...result, jobs: result.jobs.map(projectJob) };
}

export async function heartbeatJob(ctx: AppContext, id: string): Promise<JobView> {
  return ctx.jobs.heartbeat(id);
}

export async function cancelJob(ctx: AppContext, id: string): Promise<JobView> {
  return ctx.jobs.cancel(id);
}

export async function retryJob(ctx: AppContext, id: string): Promise<JobView> {
  return ctx.jobs.retry(id);
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
    if (terminal || Date.now() >= deadline) return { terminal, job: projectJob(job) };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// THE COMPLETION DISPATCHER. Replicates the original handleCompleteJob logic:
// look up the existing job (404 if missing), persist completion, then fan out to
// the side-effect handlers in a fixed order — question log update, proposal
// creation, proposal publication, then crunch-plan attachment. Returns a discriminated outcome so the
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
    return { ok: false, code: "invalid_output" };
  }

  try {
    await updateQuestionLogFromCompletedJob(ctx, existingJob, parsed.data);
    await proposalsService.createProposalFromCompletedJob(ctx, existingJob, parsed.data);
    await proposalsService.recordPublicationFromCompletedJob(ctx, existingJob, parsed.data);
    await crunchService.attachCrunchPlanFromCompletedJob(ctx, existingJob, parsed.data);
    await ctx.jobs.complete(jobId, { result: parsed.data, executor });
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

// Marks a job failed and preserves the original crunch side-effect: when the
// failing job is a crunch_knowledge_base job, its associated run is failed too.
// The two stores keep their distinct fallback messages from the original handler.
export async function failJob(
  ctx: AppContext,
  jobId: string,
  jobError: JobError
): Promise<JobView | undefined> {
  const failingJob = await ctx.jobs.get(jobId);
  const failedJob = await ctx.jobs.fail(jobId, jobError);
  if (failingJob?.type === "crunch_knowledge_base" && failedJob.state === "failed") {
    const run = await ctx.stores.crunchRuns.getRunByJobId(jobId);
    if (run) {
      await ctx.stores.crunchRuns.failRun(run.id, jobError.message);
    }
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

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key,
    /^(apiKey|token|authorization|password)$/i.test(key) ? "[redacted]" : redactSecrets(nested)
  ]));
}

function isTerminal(state: JobView["state"]): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
