import type { JobCapability, JobType, JobView } from "@magpie/jobs";
import {
  correctnessPatrolOutputSchema,
  editorialPatrolOutputSchema,
  processGapsToPullRequestsOutputSchema,
  seedBootstrapInputSchema,
  seedBootstrapOutputSchema,
  sourceChangeSyncOutputSchema,
  verifyGapClosureInputSchema,
  verifyGapClosureOutputSchema
} from "@magpie/jobs";
import type { WatcherApi } from "../http-client.js";
import { logger } from "../logger.js";

const MAINTENANCE_JOB_TYPES: ReadonlySet<JobType> = new Set([
  "process_gaps_to_pull_requests",
  "source_change_sync",
  "correctness_patrol",
  "editorial_patrol",
  "verify_gap_closure",
  "seed_bootstrap"
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
    if (job.type === "correctness_patrol") {
      return this.runFixPatrol(job, signal);
    }
    if (job.type === "editorial_patrol") {
      return this.runImprovePatrol(job, signal);
    }
    if (job.type === "verify_gap_closure") {
      return this.verifyGapClosure(job, signal);
    }
    if (job.type === "seed_bootstrap") {
      return this.runSeedBootstrap(job, signal);
    }
    throw new Error(`MaintenanceRunner cannot handle ${job.type}`);
  }

  private async runSeedBootstrap(job: JobView, signal: AbortSignal): Promise<unknown> {
    const { flowId } = seedBootstrapInputSchema.parse(job.input);
    logger.info({ jobId: job.id, flowId }, `seed_bootstrap[${job.id}]: checking sparse-flow seeding for flow ${flowId}`);
    const result = await this.api.runSeedBootstrap(flowId, signal);
    const output = seedBootstrapOutputSchema.parse(result);
    logger.info(
      { jobId: job.id, flowId, enqueued: output.enqueued, reason: output.reason ?? null },
      `seed_bootstrap[${job.id}]: ${output.enqueued ? `proposed a plan (outline job ${output.outlineJobId})` : `no-op (${output.reason})`}`
    );
    return output;
  }

  private async verifyGapClosure(job: JobView, signal: AbortSignal): Promise<unknown> {
    const { proposalId } = verifyGapClosureInputSchema.parse(job.input);
    logger.info({ jobId: job.id, proposalId }, `verify_gap_closure[${job.id}]: verifying gap closure for proposal ${proposalId}`);
    const result = await this.api.verifyClosure(proposalId, signal);
    // The API endpoint returns the verify_gap_closure output shape; validate it
    // here so a contract drift surfaces as a job failure rather than a silent
    // pass-through of the wrong payload.
    const output = verifyGapClosureOutputSchema.parse(result);
    logger.info(
      { jobId: job.id, proposalId, closureStatus: output.closureStatus, questions: output.perQuestion.length },
      `verify_gap_closure[${job.id}]: ${output.closureStatus} (${output.perQuestion.length} question(s))`
    );
    return output;
  }

  private async processGapsToPullRequests(job: JobView, signal: AbortSignal): Promise<unknown> {
    const flowId = readFlowId(job.input);
    if (!flowId) {
      throw new Error("process_gaps_to_pull_requests requires flowId");
    }
    logger.info({ jobId: job.id, flowId }, `process_gaps_to_pull_requests[${job.id}]: reconciling gaps for flow ${flowId}`);
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
    logger.info({ jobId: job.id, flowId: flowId ?? null }, `source_change_sync[${job.id}]: syncing sources for flow ${flowId ?? "(all)"}`);
    const { runIds } = await this.api.runSourceSync(flowId, signal);
    logger.info({ jobId: job.id, runCount: runIds.length }, `source_change_sync[${job.id}]: created ${runIds.length} sync run(s)`);
    return sourceChangeSyncOutputSchema.parse({ runIds });
  }

  private async runFixPatrol(job: JobView, signal: AbortSignal): Promise<unknown> {
    const flowId = readFlowId(job.input);
    logger.info({ jobId: job.id, flowId: flowId ?? null }, `correctness_patrol[${job.id}]: patrolling flow ${flowId ?? "(default)"}`);
    const { runId, selectedCount, findingCount } = await this.api.runFixPatrol(flowId, signal);
    logger.info(
      { jobId: job.id, runId, selectedCount, findingCount },
      `correctness_patrol[${job.id}]: checked ${selectedCount} document(s), ${findingCount} finding(s) (run ${runId})`
    );
    return correctnessPatrolOutputSchema.parse({ runId, selectedCount, findingCount });
  }

  private async runImprovePatrol(job: JobView, signal: AbortSignal): Promise<unknown> {
    const flowId = readFlowId(job.input);
    logger.info({ jobId: job.id, flowId: flowId ?? null }, `editorial_patrol[${job.id}]: patrolling flow ${flowId ?? "(default)"}`);
    const { runId, selectedCount, enqueuedCount } = await this.api.runImprovePatrol(flowId, signal);
    logger.info(
      { jobId: job.id, runId, selectedCount, enqueuedCount },
      `editorial_patrol[${job.id}]: selected ${selectedCount} document(s), enqueued ${enqueuedCount} scan(s) (run ${runId})`
    );
    return editorialPatrolOutputSchema.parse({ runId, selectedCount, enqueuedCount });
  }
}

function readFlowId(input: unknown): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const candidate = (input as { flowId?: unknown }).flowId;
  return typeof candidate === "string" ? candidate : undefined;
}
