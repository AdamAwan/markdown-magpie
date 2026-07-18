import type {
  DraftSeedDocumentJobInput,
  OutlineFlowSeedJobInput,
  ReviseSeedPlanJobInput,
  SeedPlan,
  SeedPlanItem
} from "@magpie/core";
import { outlineFlowSeedOutputSchema, reviseSeedPlanOutputSchema, type JobView } from "@magpie/jobs";
import type { AppContext } from "../../context.js";
import { defaultDestinationId, selectFlow } from "../../platform/repositories.js";
import { projectSourceDescriptors } from "../../platform/source-descriptors.js";
import { hashSourceDescriptors } from "../../scheduling/patrol-hash.js";
import { sameFlowOpenProposals } from "../../scheduling/flow.js";
import { listExistingDocuments } from "../retrieve/service.js";
import { type AiProviderName } from "../../platform/providers.js";
import { createFanoutBudget, type FanoutBudget } from "../../platform/maintenance-fanout.js";
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
async function draftSeedItem(
  ctx: AppContext,
  plan: SeedPlan,
  item: SeedPlanItem,
  budget: FanoutBudget
): Promise<string | undefined> {
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
  // draft_seed_document is maintenance-class AI, so its batch fan-out admits
  // through the fan-out budget (#288b). A shed leaves the item without a draftJobId;
  // approval is replay-safe, so a later re-approve drafts the remainder.
  const admission = await budget.admit("draft_seed_document", input);
  if (!admission.ok) {
    logger.info(
      { flowId: plan.flowId, planId: plan.id, reason: admission.reason },
      "draft_seed_document deferred by maintenance fan-out budget; re-approve to draft the remainder"
    );
    return undefined;
  }
  logger.info(
    { jobId: admission.job.id, flowId: plan.flowId, planId: plan.id, targetPath: input.targetPath ?? "auto" },
    "enqueued draft_seed_document job"
  );
  return admission.job.id;
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

// Enqueue a revise_seed_plan job to reshape a still-proposed plan by a
// natural-language instruction. Enqueue-only: the reshaped plan lands in place
// via reviseSeedPlanFromCompletedJob. NOT source-grounded — the current plan
// snapshot rides the input and the job never re-opens the flow's sources, so an
// iterate ("don't mention X") is cheap and does not re-plan from scratch.
export async function requestSeedPlanRevision(
  ctx: AppContext,
  planId: string,
  instruction: string
): Promise<{ ok: true; jobId: string } | { ok: false; code: "plan_not_found" | "plan_not_revisable" }> {
  const plan = await ctx.stores.seedPlans.get(planId);
  if (!plan) {
    return { ok: false as const, code: "plan_not_found" as const };
  }
  if (plan.status !== "proposed") {
    return { ok: false as const, code: "plan_not_revisable" as const };
  }
  const input: ReviseSeedPlanJobInput & { provider: AiProviderName } = {
    flowId: plan.flowId,
    planId: plan.id,
    instruction,
    currentPlan: {
      items: plan.items.map((item) => ({
        ...(item.title !== undefined ? { title: item.title } : {}),
        ...(item.targetPath !== undefined ? { targetPath: item.targetPath } : {}),
        coverage: item.coverage,
        ...(item.questions !== undefined ? { questions: item.questions } : {})
      })),
      ...(plan.charter !== undefined ? { charter: plan.charter } : {}),
      ...(plan.persona !== undefined ? { persona: plan.persona } : {}),
      rationale: plan.rationale
    },
    provider: ctx.config.get().aiProvider
  };
  const job = await ctx.jobs.create("revise_seed_plan", input);
  logger.info({ jobId: job.id, planId: plan.id, flowId: plan.flowId }, "enqueued revise_seed_plan job");
  return { ok: true as const, jobId: job.id };
}

// Completion handler for revise_seed_plan: apply the reshaped plan in place.
// Only while the plan is still "proposed" — a concurrent approve/dismiss wins and
// the stale revision is dropped. Keeps the plan id, flow, origin, outlineJobId,
// sourceHash and the charter/persona *proposed provenance flags; replaces items
// (fresh proposed ids) and rationale, and charter/persona when the output carries
// them.
export async function reviseSeedPlanFromCompletedJob(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<SeedPlan | undefined> {
  if (!job || job.type !== "revise_seed_plan") {
    return undefined;
  }
  const parsed = reviseSeedPlanOutputSchema.safeParse(output);
  if (!parsed.success) {
    return undefined;
  }
  const input = job.input as Partial<ReviseSeedPlanJobInput>;
  if (!input.planId) {
    return undefined;
  }
  const plan = await ctx.stores.seedPlans.get(input.planId);
  if (!plan || plan.status !== "proposed") {
    if (plan) {
      logger.info(
        { planId: plan.id, status: plan.status },
        "revise_seed_plan completion dropped: plan no longer proposed"
      );
    }
    return undefined;
  }
  const updated = await ctx.stores.seedPlans.revise(plan.id, {
    items: parsed.data.items,
    ...(parsed.data.charter !== undefined ? { charter: parsed.data.charter } : {}),
    ...(parsed.data.persona !== undefined ? { persona: parsed.data.persona } : {}),
    rationale: parsed.data.rationale
  });
  logger.info({ planId: plan.id, flowId: plan.flowId, items: updated?.items.length }, "revised seed plan in place");
  return updated;
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
  // One fan-out budget for this approval's draft batch (#288b). A big plan can't
  // enqueue past the per-tick budget or the global non-interactive ceiling in one
  // approve; a shed stops the batch and the replay-safe re-approve resumes it.
  const budget = createFanoutBudget(ctx, "approve_seed_plan", plan.flowId);
  const jobIds: string[] = [];
  for (const item of toDraft) {
    if (item.draftJobId) {
      continue;
    }
    const jobId = await draftSeedItem(ctx, { ...plan, status: "approved" }, item, budget);
    if (!jobId) {
      // Budget/capacity exhausted for this approval — defer the rest to a re-approve.
      break;
    }
    await ctx.stores.seedPlans.setItemDraftJob(plan.id, item.id, jobId);
    jobIds.push(jobId);
  }
  budget.finish();
  const updated = await ctx.stores.seedPlans.get(plan.id);
  logger.info(
    { planId: plan.id, flowId: plan.flowId, enqueued: jobIds.length },
    "approved seed plan: enqueued draft_seed_document jobs"
  );
  return { ok: true as const, plan: updated ?? plan, jobIds };
}

// Sparse-flow auto-seeding tick (thin orchestration endpoint body). Checks the
// guards in cheapest-first order and proposes a plan only when the flow has
// sources, a near-empty KB, and no pending/duplicate/vetoed planning work.
// Enqueue-and-return: unlike the patrols it never bounded-waits — the plan
// lands via createSeedPlanFromCompletedJob. Dismissal is sticky per source
// config: a human "no" is re-litigated only when the flow's sources change.
export async function runSeedBootstrap(
  ctx: AppContext,
  flowId: string
): Promise<
  { ok: true; enqueued: boolean; reason?: string; outlineJobId?: string } | { ok: false; code: "flow_not_found" }
> {
  const deps = ctx.repositoryDeps();
  const flow = selectFlow(deps, flowId);
  if (!flow) {
    return { ok: false as const, code: "flow_not_found" as const };
  }
  const sources = projectSourceDescriptors(deps, flow.sourceIds);
  if (sources.length === 0) {
    return { ok: true as const, enqueued: false, reason: "no_sources" };
  }
  if (listExistingDocuments(ctx, flowId).length >= ctx.settings.seeding.bootstrapMaxDocs) {
    return { ok: true as const, enqueued: false, reason: "kb_populated" };
  }
  if (await ctx.stores.seedPlans.latestByFlow(flowId, "proposed")) {
    return { ok: true as const, enqueued: false, reason: "plan_pending" };
  }
  if (await findInFlightOutlineJob(ctx, flowId)) {
    return { ok: true as const, enqueued: false, reason: "outline_in_flight" };
  }
  const openProposals = await sameFlowOpenProposals(ctx, flowId);
  if (openProposals.some((proposal) => proposal.seedPlanId)) {
    return { ok: true as const, enqueued: false, reason: "seed_proposals_open" };
  }
  const dismissed = await ctx.stores.seedPlans.latestByFlow(flowId, "dismissed");
  if (dismissed && dismissed.sourceHash === hashSourceDescriptors(sources)) {
    return { ok: true as const, enqueued: false, reason: "dismissed_unchanged" };
  }
  const outcome = await outlineFlowSeed(ctx, flowId, { origin: "auto" });
  if (!outcome.ok) {
    return { ok: false as const, code: "flow_not_found" as const };
  }
  logger.info({ flowId, outlineJobId: outcome.jobId, reused: outcome.reused }, "seed bootstrap proposed a plan");
  return { ok: true as const, enqueued: true, outlineJobId: outcome.jobId };
}
