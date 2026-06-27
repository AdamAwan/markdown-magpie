import type { JobCapability, JobType, JobView } from "@magpie/jobs";
import {
  fixPatrolOutputSchema,
  improvePatrolOutputSchema,
  processGapsToPullRequestsOutputSchema,
  sourceChangeSyncOutputSchema
} from "@magpie/jobs";
import type { WatcherApi } from "../http-client.js";

const MAINTENANCE_JOB_TYPES: ReadonlySet<JobType> = new Set([
  "process_gaps_to_pull_requests",
  "source_change_sync",
  "fix_patrol",
  "improve_patrol"
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
    if (job.type === "fix_patrol") {
      return this.runFixPatrol(job, signal);
    }
    if (job.type === "improve_patrol") {
      return this.runImprovePatrol(job, signal);
    }
    throw new Error(`MaintenanceRunner cannot handle ${job.type}`);
  }

  private async processGapsToPullRequests(job: JobView, signal: AbortSignal): Promise<unknown> {
    // The job's input schema is `{}`, but the schedule may carry a flowId for a
    // per-flow reconcile; read it defensively without widening the contract.
    const flowId = readFlowId(job.input);
    console.log(`process_gaps_to_pull_requests[${job.id}]: reconciling gaps for flow ${flowId ?? "(default)"}`);
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
    console.log(`source_change_sync[${job.id}]: syncing sources for flow ${flowId ?? "(all)"}`);
    const output = await this.api.runSourceSync(flowId, signal);
    console.log(
      `source_change_sync[${job.id}]: recorded ${output.maintenanceRunIds.length} maintenance run(s), ` +
        `created ${output.proposalIds.length} proposal(s)`
    );
    return sourceChangeSyncOutputSchema.parse(output);
  }

  private async runFixPatrol(job: JobView, signal: AbortSignal): Promise<unknown> {
    const flowId = readFlowId(job.input);
    console.log(`fix_patrol[${job.id}]: patrolling flow ${flowId ?? "(default)"}`);
    const { runId, selectedCount, findingCount } = await this.api.runFixPatrol(flowId, signal);
    console.log(`fix_patrol[${job.id}]: checked ${selectedCount} document(s), ${findingCount} finding(s) (run ${runId})`);
    return fixPatrolOutputSchema.parse({ runId, selectedCount, findingCount });
  }

  private async runImprovePatrol(job: JobView, signal: AbortSignal): Promise<unknown> {
    const flowId = readFlowId(job.input);
    console.log(`improve_patrol[${job.id}]: patrolling flow ${flowId ?? "(default)"}`);
    const { runId, selectedCount, enqueuedCount } = await this.api.runImprovePatrol(flowId, signal);
    console.log(
      `improve_patrol[${job.id}]: selected ${selectedCount} document(s), enqueued ${enqueuedCount} scan(s) (run ${runId})`
    );
    return improvePatrolOutputSchema.parse({ runId, selectedCount, enqueuedCount });
  }
}

function readFlowId(input: unknown): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const candidate = (input as { flowId?: unknown }).flowId;
  return typeof candidate === "string" ? candidate : undefined;
}
