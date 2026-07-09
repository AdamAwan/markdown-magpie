import type {
  DraftSeedDocumentJobInput,
  OutlineFlowSeedJobInput,
  SeedPlan,
  SeedPlanItem
} from "@magpie/core";
import { outlineFlowSeedOutputSchema, type JobView } from "@magpie/jobs";
import type { AppContext } from "../../context.js";
import { defaultDestinationId, selectFlow } from "../../platform/repositories.js";
import { projectSourceDescriptors } from "../../platform/source-descriptors.js";
import { hashSourceDescriptors } from "../../scheduling/patrol-hash.js";
import { listExistingDocuments } from "../retrieve/service.js";
import { type AiProviderName } from "../../platform/providers.js";
import { logger } from "../../logger.js";
import type { SeedPlanPatchBody } from "./schema.js";

// Enqueue a draft_seed_document for one approved plan item. Reuses the
// flow/source/destination resolution draftFromGaps uses, but skips the
// gap-candidate matching — seed coverage is reviewed intent, not a logged gap.
// The plan's run-scoped charter/persona ride the input (charter bounds scope,
// persona shapes voice) and seedPlanId links the eventual proposal back to the
// plan. Enqueue-only: the proposal lands later via
// createSeedProposalFromCompletedJob (a completion handler in the proposals
// service).
async function draftSeedItem(ctx: AppContext, plan: SeedPlan, item: SeedPlanItem): Promise<string> {
  const deps = ctx.repositoryDeps();
  const flow = selectFlow(deps, plan.flowId);
  const input: DraftSeedDocumentJobInput & { provider: AiProviderName } = {
    flowId: plan.flowId,
    title: item.title?.trim() || undefined,
    targetPath: item.targetPath?.trim() || undefined,
    coverage: [...new Set(item.coverage.map((point) => point.trim()).filter((point) => point.length > 0))],
    questions: item.questions?.length ? item.questions : undefined,
    sources: projectSourceDescriptors(deps, flow?.sourceIds),
    destinationId: flow?.destinationId || defaultDestinationId(deps),
    ...(plan.charter ? { charter: plan.charter } : {}),
    ...(plan.persona ? { persona: plan.persona } : {}),
    seedPlanId: plan.id,
    provider: ctx.config.get().aiProvider
  };
  const job = await ctx.jobs.create("draft_seed_document", input);
  logger.info(
    { jobId: job.id, flowId: plan.flowId, planId: plan.id, targetPath: input.targetPath ?? "auto" },
    "enqueued draft_seed_document job"
  );
  return job.id;
}

// Find an in-flight (non-terminal) outline job for this flow so a second
// propose click / bootstrap tick reuses it instead of double-planning.
async function findInFlightOutlineJob(ctx: AppContext, flowId: string): Promise<JobView | undefined> {
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

// Completion handler for outline_flow_seed: persist the proposed plan for
// review. Idempotent on the job id (store-level unique on outline_job_id).
// A fresh proposed plan supersedes an older still-proposed plan for the flow —
// the newer exploration reflects newer sources/config. Charter/persona are
// resolved run-scoped: the flow config's value when the input carried one,
// else the model's proposal (flagged so the console offers copy-to-config).
export async function createSeedPlanFromCompletedJob(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<SeedPlan | undefined> {
  if (!job || job.type !== "outline_flow_seed") {
    return undefined;
  }
  const parsed = outlineFlowSeedOutputSchema.safeParse(output);
  if (!parsed.success) {
    return undefined;
  }
  const input = job.input as Partial<OutlineFlowSeedJobInput>;
  if (!input.flowId) {
    return undefined;
  }
  const previous = await ctx.stores.seedPlans.latestByFlow(input.flowId, "proposed");
  const charter = input.charter ?? parsed.data.proposedCharter;
  const persona = input.persona ?? parsed.data.proposedPersona;
  const plan = await ctx.stores.seedPlans.create({
    flowId: input.flowId,
    origin: input.origin ?? "manual",
    ...(charter !== undefined ? { charter } : {}),
    ...(persona !== undefined ? { persona } : {}),
    charterProposed: !input.charter && Boolean(parsed.data.proposedCharter),
    personaProposed: !input.persona && Boolean(parsed.data.proposedPersona),
    items: parsed.data.items,
    rationale: parsed.data.rationale,
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    outlineJobId: job.id,
    sourceHash: hashSourceDescriptors(input.sources ?? [])
  });
  if (previous && previous.id !== plan.id) {
    await ctx.stores.seedPlans.setStatus(previous.id, "superseded");
  }
  logger.info(
    { planId: plan.id, flowId: plan.flowId, items: plan.items.length, superseded: previous?.id },
    "persisted seed plan from completed outline job"
  );
  return plan;
}

// --- Plan review -----------------------------------------------------------
// Thin wrappers over the seed-plan store that enforce the status rules the
// spec locks: plans are edited/dismissed only while "proposed"; approval is
// re-enterable so a mid-loop enqueue failure recovers by re-approving.

export async function listSeedPlans(ctx: AppContext, flowId: string): Promise<SeedPlan[]> {
  return ctx.stores.seedPlans.listByFlow(flowId);
}

export async function getSeedPlan(ctx: AppContext, planId: string): Promise<SeedPlan | undefined> {
  return ctx.stores.seedPlans.get(planId);
}

export async function patchSeedPlan(
  ctx: AppContext,
  planId: string,
  patch: SeedPlanPatchBody
): Promise<{ ok: true; plan: SeedPlan } | { ok: false; code: "plan_not_found" | "plan_not_editable" }> {
  const plan = await ctx.stores.seedPlans.get(planId);
  if (!plan) {
    return { ok: false as const, code: "plan_not_found" as const };
  }
  if (plan.status !== "proposed") {
    return { ok: false as const, code: "plan_not_editable" as const };
  }
  const updated = await ctx.stores.seedPlans.patch(planId, patch);
  return { ok: true as const, plan: updated ?? plan };
}

export async function dismissSeedPlan(
  ctx: AppContext,
  planId: string
): Promise<{ ok: true; plan: SeedPlan } | { ok: false; code: "plan_not_found" | "plan_not_dismissable" }> {
  const plan = await ctx.stores.seedPlans.get(planId);
  if (!plan) {
    return { ok: false as const, code: "plan_not_found" as const };
  }
  if (plan.status !== "proposed") {
    return { ok: false as const, code: "plan_not_dismissable" as const };
  }
  const updated = await ctx.stores.seedPlans.setStatus(planId, "dismissed");
  logger.info({ planId, flowId: plan.flowId }, "dismissed seed plan");
  return { ok: true as const, plan: updated ?? plan };
}

// Approve a plan: flip remaining proposed items to approved and enqueue one
// draft_seed_document per non-dismissed item. The plan status is set to
// "approved" BEFORE the enqueue loop deliberately: a mid-loop crash leaves an
// approved plan with partial draftJobIds, and re-approving completes the
// remainder (items that already carry a draftJobId are skipped).
export async function approveSeedPlan(
  ctx: AppContext,
  planId: string
): Promise<
  | { ok: true; plan: SeedPlan; jobIds: string[] }
  | { ok: false; code: "plan_not_found" | "plan_not_approvable" | "coverage_required" }
> {
  const plan = await ctx.stores.seedPlans.get(planId);
  if (!plan) {
    return { ok: false as const, code: "plan_not_found" as const };
  }
  if (plan.status !== "proposed" && plan.status !== "approved") {
    return { ok: false as const, code: "plan_not_approvable" as const };
  }
  const toDraft = plan.items.filter((item) => item.status !== "dismissed");
  if (toDraft.some((item) => !item.coverage.some((point) => point.trim().length > 0))) {
    return { ok: false as const, code: "coverage_required" as const };
  }
  await ctx.stores.seedPlans.patch(plan.id, {
    items: toDraft
      .filter((item) => item.status === "proposed")
      .map((item) => ({ id: item.id, status: "approved" as const }))
  });
  await ctx.stores.seedPlans.setStatus(plan.id, "approved");
  const jobIds: string[] = [];
  for (const item of toDraft) {
    if (item.draftJobId) {
      continue;
    }
    const jobId = await draftSeedItem(ctx, { ...plan, status: "approved" }, item);
    await ctx.stores.seedPlans.setItemDraftJob(plan.id, item.id, jobId);
    jobIds.push(jobId);
  }
  const updated = await ctx.stores.seedPlans.get(plan.id);
  logger.info(
    { planId: plan.id, flowId: plan.flowId, enqueued: jobIds.length },
    "approved seed plan: enqueued draft_seed_document jobs"
  );
  return { ok: true as const, plan: updated ?? plan, jobIds };
}
