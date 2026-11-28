import type { Context } from "hono";
import { z } from "zod";
import type { JobType, JobView } from "@magpie/jobs";
import type { AppContext } from "../../context.js";
import { can, canAny } from "../../auth/capabilities.js";

// Flow-scoped visibility for the job READ routes (GET /api/jobs, /:id, /:id/wait;
// docs/authorization.md AZ34).
//
// A job's input and output carry flow content — questions and answers, draft
// Markdown, source-derived excerpts — so they are shown only to a caller who may
// see that flow. Jobs are nonetheless REDACTED rather than hidden: the job list is
// the operator's view of the queue (an ops admin watches every job without holding
// any flow `read`, AZ17), and it is paginated by the broker, so dropping rows
// would make its totals lie. A redacted job keeps its id, type, state, timing and
// error code/category and loses everything that could carry content.

const ANSWER_JOB_TYPES: ReadonlySet<JobType> = new Set<JobType>(["answer_question", "answer_question_batch"]);

const inputFlowSchema = z.object({ flowId: z.string() });
const answerInputFlowSchema = z.object({
  requestedFlowId: z.string().optional(),
  conversationFlowId: z.string().optional()
});
const answerOutputFlowSchema = z.object({ result: z.object({ flowId: z.string() }) });

// The flow a job belongs to: the `flowId` most job inputs carry; for an answer
// job, the flow it was answered in (the completed output), else the flow it was
// asked in. Undefined for a flow-less job (e.g. the all-flows snapshot refresh),
// which only a "*" grant can see into (AZ14).
function jobFlowId(job: JobView): string | undefined {
  const direct = inputFlowSchema.safeParse(job.input);
  if (direct.success) {
    return direct.data.flowId;
  }
  if (!ANSWER_JOB_TYPES.has(job.type)) {
    return undefined;
  }
  const answered = answerOutputFlowSchema.safeParse(job.output);
  if (answered.success) {
    return answered.data.result.flowId;
  }
  const asked = answerInputFlowSchema.safeParse(job.input);
  return asked.success ? (asked.data.requestedFlowId ?? asked.data.conversationFlowId) : undefined;
}

// Who may see a job's content: anyone who may read or manage its flow, and — for
// an answer job — anyone who may ask in it, so an asker (the console Ask page, MCP
// kb_ask) can read the answer it is waiting on.
function canSeeJobContent(ctx: AppContext, c: Context, job: JobView): boolean {
  const flowId = jobFlowId(job);
  if (canAny(ctx, c, ["read", "manage"], flowId)) {
    return true;
  }
  return ANSWER_JOB_TYPES.has(job.type) && can(ctx, c, "ask", flowId);
}

export type VisibleJobView = JobView & { redacted?: true };

const REDACTED_ERROR_MESSAGE = "Job details are not visible to this caller.";

function redactJob(job: JobView): VisibleJobView {
  const { output: _output, repair: _repair, traceContext: _traceContext, error, ...metadata } = job;
  return {
    ...metadata,
    input: {},
    ...(error ? { error: { code: error.code, category: error.category, message: REDACTED_ERROR_MESSAGE } } : {}),
    redacted: true
  };
}

// The job as this caller may see it: unchanged when they may see its flow, else
// redacted.
export function visibleJob(ctx: AppContext, c: Context, job: JobView): VisibleJobView {
  return canSeeJobContent(ctx, c, job) ? job : redactJob(job);
}
