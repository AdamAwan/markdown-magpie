import type { JobCapability, JobType, JobView } from "@magpie/jobs";
import {
  processGapsToPullRequestsOutputSchema,
  sourceChangeSyncOutputSchema,
  triggerScheduledCrunchOutputSchema
} from "@magpie/jobs";
import type { WatcherApi } from "../http-client.js";

const MAINTENANCE_JOB_TYPES: ReadonlySet<JobType> = new Set([
  "process_gaps_to_pull_requests",
  "source_change_sync",
  "trigger_scheduled_crunch"
]);

// Runs the scheduled maintenance jobs by POSTing a thin API endpoint, keeping the
// heavy reconciler orchestration (and its store access) inside the API. The
// reshape's only generative step is itself an enqueued AI job the API
// bounded-waits on, so this runner needs no model provider.
export class MaintenanceRunner {
  readonly capability: JobCapability = "maintenance";

  constructor(private readonly api: WatcherApi) {}

  supports(type: JobType): boolean {
    return MAINTENANCE_JOB_TYPES.has(type);
  }

  async run(job: JobView, signal: AbortSignal): Promise<unknown> {
    if (job.type === "process_gaps_to_pull_requests") {
      return this.processGapsToPullRequests(job, signal);
    }
    if (job.type === "source_change_sync") {
      return this.runSourceSync(job, signal);
    }
    if (job.type === "trigger_scheduled_crunch") {
      return this.triggerScheduledCrunch(job, signal);
    }
    throw new Error(`MaintenanceRunner cannot handle ${job.type}`);
  }

  private async processGapsToPullRequests(job: JobView, signal: AbortSignal): Promise<unknown> {
    // The job's input schema is `{}`, but the schedule may carry a flowId for a
    // per-flow reconcile; read it defensively without widening the contract.
    const flowId = readFlowId(job.input);
    await this.api.reconcileGaps(flowId, signal);

    // TODO(Task 8E/follow-up): reconcile endpoint returns no counts; returning
    // zeros under-reports actual drafted/published. Surface real counts when the
    // endpoint exposes them.
    return processGapsToPullRequestsOutputSchema.parse({ drafted: 0, published: 0 });
  }

  private async runSourceSync(job: JobView, signal: AbortSignal): Promise<unknown> {
    // The job's input schema is `{}`, but the schedule may carry a flowId for a
    // per-flow watch; read it defensively without widening the contract.
    const flowId = readFlowId(job.input);
    const { runIds } = await this.api.runSourceSync(flowId, signal);
    return sourceChangeSyncOutputSchema.parse({ runIds });
  }

  private async triggerScheduledCrunch(job: JobView, signal: AbortSignal): Promise<unknown> {
    // The job's input optionally carries the flow to crunch; the API's enqueue-only
    // /api/crunch/run does the heavy gather + planning-job enqueue. We just relay
    // the trigger and return the created run/job ids.
    const flowId = readFlowId(job.input);
    const { runId, jobId } = await this.api.triggerScheduledCrunch(flowId, signal);
    return triggerScheduledCrunchOutputSchema.parse({ runId, jobId });
  }
}

function readFlowId(input: unknown): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const candidate = (input as { flowId?: unknown }).flowId;
  return typeof candidate === "string" ? candidate : undefined;
}
