import type {
  DraftSeedDocumentJobInput,
  OutlineFlowSeedJobInput,
  SeedItem
} from "@magpie/core";
import type { AppContext } from "../../context.js";
import { defaultDestinationId, selectFlow } from "../../platform/repositories.js";
import { projectSourceDescriptors } from "../../platform/source-descriptors.js";
import { describeExistingDocuments } from "../retrieve/service.js";
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

// Propose a seed outline for a topic: enqueue an outline_flow_seed job grounded in the
// flow's existing docs (retrieved inline for the topic) so the model proposes a doc list
// that fits the current structure. Enqueue-only — the proposed SeedItem[] lands as the
// job's output; a human reviews/edits it in the console, then the seed path above
// executes it. Like the rest of seeding it bypasses the gap pipeline entirely, and
// (unlike draftSeedItem) it authors nothing: it only plans.
export async function outlineFlowSeed(
  ctx: AppContext,
  flowId: string,
  request: { topic: string; notes?: string }
): Promise<{ ok: true; jobId: string } | { ok: false; code: string }> {
  const flow = selectFlow(ctx.repositoryDeps(), flowId);
  if (!flow) {
    return { ok: false as const, code: "flow_not_found" };
  }
  const topic = request.topic.trim();
  if (topic.length === 0) {
    return { ok: false as const, code: "topic_required" };
  }
  const existingDocuments = await describeExistingDocuments(ctx, flowId, topic);
  const input: OutlineFlowSeedJobInput & { provider: AiProviderName } = {
    flowId,
    topic,
    notes: request.notes?.trim() || undefined,
    existingDocuments,
    ...(flow.persona ? { persona: flow.persona } : {}),
    provider: ctx.config.get().aiProvider
  };
  const job = await ctx.jobs.create("outline_flow_seed", input);
  logger.info({ jobId: job.id, flowId, existingDocs: existingDocuments.length }, "enqueued outline_flow_seed job");
  return { ok: true as const, jobId: job.id };
}
