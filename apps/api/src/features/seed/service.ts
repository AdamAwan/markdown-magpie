import type {
  DraftSeedDocumentJobInput,
  OutlineFlowSeedJobInput,
  SeedItem
} from "@magpie/core";
import type { JobView } from "@magpie/jobs";
import type { AppContext } from "../../context.js";
import { defaultDestinationId, selectFlow } from "../../platform/repositories.js";
import { projectSourceDescriptors } from "../../platform/source-descriptors.js";
import { listExistingDocuments } from "../retrieve/service.js";
import { type AiProviderName } from "../../platform/providers.js";
import { logger } from "../../logger.js";

// Enqueue a draft_seed_document for one seed item. Reuses the flow/source/
// destination resolution draftFromGaps uses, but skips the gap-candidate matching
// draftFromGaps requires — seed coverage is authored intent, not a logged gap.
// Enqueue-only: the proposal lands later via createSeedProposalFromCompletedJob
// (a completion handler in the proposals service).
async function draftSeedItem(
  ctx: AppContext,
  flowId: string,
  item: SeedItem
): Promise<string> {
  const deps = ctx.repositoryDeps();
  const flow = selectFlow(deps, flowId);
  const sourceIds = flow?.sourceIds;
  const destinationId = flow?.destinationId || defaultDestinationId(deps);
  const input: DraftSeedDocumentJobInput & { provider: AiProviderName } = {
    flowId,
    title: item.title?.trim() || undefined,
    targetPath: item.targetPath?.trim() || undefined,
    coverage: [...new Set(item.coverage.map((point) => point.trim()).filter((point) => point.length > 0))],
    questions: item.questions?.length ? item.questions : undefined,
    sources: projectSourceDescriptors(deps, sourceIds),
    destinationId,
    provider: ctx.config.get().aiProvider
  };
  const job = await ctx.jobs.create("draft_seed_document", input);
  logger.info({ jobId: job.id, flowId, targetPath: input.targetPath ?? "auto" }, "enqueued draft_seed_document job");
  return job.id;
}

// Seed a flow: draft each item straight into a proposal, bypassing gap clustering
// and the intent gate.
export async function seedFlow(
  ctx: AppContext,
  flowId: string,
  items: SeedItem[]
): Promise<{ ok: true; jobIds: string[] } | { ok: false; code: string }> {
  const flow = selectFlow(ctx.repositoryDeps(), flowId);
  if (!flow) {
    return { ok: false as const, code: "flow_not_found" };
  }
  const usable = items.filter((item) => item.coverage.some((point) => point.trim().length > 0));
  if (usable.length === 0) {
    return { ok: false as const, code: "coverage_required" };
  }
  const jobIds: string[] = [];
  for (const item of usable) {
    jobIds.push(await draftSeedItem(ctx, flowId, item));
  }
  logger.info({ flowId, count: jobIds.length }, "seeded flow: enqueued draft_seed_document jobs");
  return { ok: true as const, jobIds };
}

// Find an in-flight (non-terminal) outline job for this flow so a second
// propose click / bootstrap tick reuses it instead of double-planning.
export async function findInFlightOutlineJob(ctx: AppContext, flowId: string): Promise<JobView | undefined> {
  const { jobs } = await ctx.jobs.list({ type: "outline_flow_seed", limit: 200 });
  return jobs.find((job) => {
    if (!["created", "retry", "active", "blocked"].includes(job.state)) {
      return false;
    }
    const input = job.input as Partial<OutlineFlowSeedJobInput>;
    return input.flowId === flowId;
  });
}

// Propose a seed plan for a flow: enqueue the source-grounded outline_flow_seed
// job. No topic — the agent explores the sources and plans the whole flow,
// scoped by the flow's charter when configured. Enqueue-only: the plan row is
// created by createSeedPlanFromCompletedJob when the job lands.
export async function outlineFlowSeed(
  ctx: AppContext,
  flowId: string,
  request: { notes?: string; origin: "manual" | "auto" }
): Promise<{ ok: true; jobId: string; reused: boolean } | { ok: false; code: string }> {
  const deps = ctx.repositoryDeps();
  const flow = selectFlow(deps, flowId);
  if (!flow) {
    return { ok: false as const, code: "flow_not_found" };
  }
  const inFlight = await findInFlightOutlineJob(ctx, flowId);
  if (inFlight) {
    return { ok: true as const, jobId: inFlight.id, reused: true };
  }
  const input: OutlineFlowSeedJobInput & { provider: AiProviderName } = {
    flowId,
    origin: request.origin,
    notes: request.notes?.trim() || undefined,
    sources: projectSourceDescriptors(deps, flow.sourceIds),
    existingDocuments: listExistingDocuments(ctx, flowId),
    ...(flow.persona ? { persona: flow.persona } : {}),
    ...(flow.charter ? { charter: flow.charter } : {}),
    ...(flow.routingSummary ? { routingSummary: flow.routingSummary } : {}),
    provider: ctx.config.get().aiProvider
  };
  const job = await ctx.jobs.create("outline_flow_seed", input);
  logger.info(
    { jobId: job.id, flowId, origin: request.origin, sources: input.sources.length },
    "enqueued outline_flow_seed job"
  );
  return { ok: true as const, jobId: job.id, reused: false };
}
