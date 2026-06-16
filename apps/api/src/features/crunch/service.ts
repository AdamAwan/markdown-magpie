import type {
  AiJob,
  ChangesetChange,
  CrunchKnowledgeBaseJobInput,
  CrunchPlan,
  CrunchRun,
  CrunchRunTrigger
} from "@magpie/core";
import { buildMockCrunchPlan } from "@magpie/core";
import { LocalGitProposalPublisher } from "@magpie/git";
import type { AppContext } from "../../context.js";
import { DEFAULT_CRUNCH_CRON } from "../../stores/crunch-store.js";
import { defaultDestinationId, findRepositoryForDestination, selectFlow } from "../../platform/repositories.js";
import { normalizeRelativePath } from "../../platform/paths.js";
import { parseJsonObject } from "../../platform/json.js";
import { type AiProviderName } from "../../platform/providers.js";

export async function listRuns(ctx: AppContext, limit: number): Promise<CrunchRun[]> {
  return ctx.stores.crunchRuns.listRuns(limit);
}

export async function getRun(ctx: AppContext, id: string): Promise<CrunchRun | undefined> {
  return ctx.stores.crunchRuns.getRun(id);
}

// Shared by the manual trigger endpoint and the scheduler. In direct mode the
// plan is produced synchronously; in queue mode a job is enqueued and the run is
// completed later by the watcher via attachCrunchPlanFromCompletedJob().
export async function triggerCrunchRun(
  ctx: AppContext,
  options: { flowId?: string; trigger: CrunchRunTrigger }
): Promise<CrunchRun> {
  const deps = ctx.repositoryDeps();
  const flow = selectFlow(deps, options.flowId);
  const flowId = flow?.id ?? options.flowId;
  const destinationId = flow?.destinationId ?? defaultDestinationId(deps);
  const documents = gatherCrunchDocuments(ctx, destinationId);
  const input = {
    flowId,
    destinationId,
    documents,
    expectedOutput: "crunch_plan",
    provider: ctx.config.get().aiProvider
  } satisfies CrunchKnowledgeBaseJobInput & { provider: AiProviderName };

  console.log(
    `Crunch run requested (trigger=${options.trigger}, flow=${flowId ?? "default"}, ` +
      `destination=${destinationId ?? "none"}, documents=${documents.length}, ` +
      `provider=${ctx.config.get().aiProvider}, mode=${ctx.config.get().aiExecutionMode})`
  );

  if (ctx.config.get().aiExecutionMode === "direct") {
    try {
      const plan = await crunchKnowledgeBaseDirect(ctx, input);
      return ctx.stores.crunchRuns.createRun({
        flowId,
        destinationId,
        trigger: options.trigger,
        documentCount: documents.length,
        status: "completed",
        plan
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Crunch planning failed";
      return ctx.stores.crunchRuns.createRun({
        flowId,
        destinationId,
        trigger: options.trigger,
        documentCount: documents.length,
        status: "failed",
        error: message
      });
    }
  }

  const job = await ctx.stores.aiJobs.enqueue("crunch_knowledge_base", input);
  return ctx.stores.crunchRuns.createRun({
    flowId,
    destinationId,
    trigger: options.trigger,
    documentCount: documents.length,
    status: "running",
    jobId: job.id
  });
}

export function gatherCrunchDocuments(ctx: AppContext, destinationId: string | undefined) {
  const documents = ctx.stores.knowledgeIndex.listDocuments();
  const scoped = destinationId ? documents.filter((document) => document.repositoryId === destinationId) : documents;
  return scoped.map((document) => ({ path: document.path, content: document.content }));
}

export async function crunchKnowledgeBaseDirect(
  ctx: AppContext,
  input: CrunchKnowledgeBaseJobInput
): Promise<CrunchPlan> {
  if (ctx.config.get().aiProvider === "mock") {
    return buildMockCrunchPlan(input.documents);
  }

  const response = await ctx.providers.chat(ctx.config.get().aiProvider).complete({
    system:
      "You tidy a fragmented Markdown knowledge base by proposing structural maintenance only. " +
      "Consolidate overlapping or tiny documents and split large multi-topic documents. Preserve all information. " +
      'Return JSON only with this shape: {"summary":"string","operations":[{"kind":"consolidate|split|rewrite",' +
      '"title":"string","reason":"string","sources":["path"],"writes":[{"path":"string","content":"string"}],' +
      '"deletes":["path"]}],"rationale":"string"}. Use existing document paths exactly. ' +
      "If the knowledge base is already tidy, return an empty operations array.",
    messages: [
      {
        role: "user",
        content: JSON.stringify(input, null, 2)
      }
    ]
  });
  const output = parseJsonObject(response.content);

  if (!isCrunchPlan(output)) {
    throw new Error("Direct crunch provider returned invalid plan output");
  }

  return output;
}

export async function attachCrunchPlanFromCompletedJob(
  ctx: AppContext,
  job: AiJob | undefined,
  output: unknown
): Promise<void> {
  if (!job || job.type !== "crunch_knowledge_base") {
    return;
  }

  const run = await ctx.stores.crunchRuns.getRunByJobId(job.id);
  if (!run) {
    return;
  }

  if (isCrunchPlan(output)) {
    await ctx.stores.crunchRuns.completeRun(run.id, output);
  } else {
    await ctx.stores.crunchRuns.failRun(run.id, "Crunch job returned an invalid plan");
  }
}

export function isCrunchPlan(value: unknown): value is CrunchPlan {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<CrunchPlan>;
  if (typeof candidate.summary !== "string" || !Array.isArray(candidate.operations)) {
    return false;
  }

  return candidate.operations.every(
    (operation) =>
      operation &&
      typeof operation.title === "string" &&
      Array.isArray(operation.writes) &&
      Array.isArray(operation.deletes) &&
      operation.writes.every((write) => write && typeof write.path === "string" && typeof write.content === "string") &&
      operation.deletes.every((deletion) => typeof deletion === "string")
  );
}

// Flattens a plan's operations into a single de-duplicated changeset. Deletes are
// applied first, then writes, so a path that is both deleted and (re)written ends
// up as a write — a split that reuses the original path stays a write, not a
// delete.
export function changesetFromPlan(plan: CrunchPlan): ChangesetChange[] {
  const changes = new Map<string, ChangesetChange>();
  for (const operation of plan.operations) {
    for (const deletion of operation.deletes) {
      changes.set(normalizeRelativePath(deletion), { path: deletion, delete: true });
    }
  }
  for (const operation of plan.operations) {
    for (const write of operation.writes) {
      changes.set(normalizeRelativePath(write.path), { path: write.path, content: write.content });
    }
  }
  return [...changes.values()];
}

export function crunchBranchName(run: CrunchRun): string {
  return `magpie/crunch-${run.id.slice(0, 8)}`;
}

// Publishes a completed crunch run's plan to a Git branch. Returns a
// discriminated outcome the handler maps to status codes: 404
// crunch_run_not_found; 409 crunch_run_not_publishable / crunch_run_empty_plan /
// crunch_repository_not_found / crunch_repository_not_git / crunch_publish_failed;
// success carries the updated run and publication for a 200.
export async function publishRun(ctx: AppContext, runId: string) {
  const run = await ctx.stores.crunchRuns.getRun(runId);
  if (!run) {
    return { ok: false as const, status: 404 as const, code: "crunch_run_not_found" };
  }

  if (run.status !== "completed" || !run.plan) {
    return {
      ok: false as const,
      status: 409 as const,
      code: "crunch_run_not_publishable",
      message: "Only completed crunch runs with a plan can be published."
    };
  }

  const changes = changesetFromPlan(run.plan);
  if (changes.length === 0) {
    return {
      ok: false as const,
      status: 409 as const,
      code: "crunch_run_empty_plan",
      message: "This crunch plan does not change any files."
    };
  }

  const repository = await findRepositoryForDestination(ctx.repositoryDeps(), run.destinationId);
  if (!repository) {
    return {
      ok: false as const,
      status: 409 as const,
      code: "crunch_repository_not_found",
      message: "No indexed Git repository matches this crunch run's destination."
    };
  }

  if (repository.git?.scope === "not-git" || !repository.git?.workTreeRoot) {
    return {
      ok: false as const,
      status: 409 as const,
      code: "crunch_repository_not_git",
      message: "The matched repository is not a Git checkout."
    };
  }

  try {
    const publisher = new LocalGitProposalPublisher();
    const publication = await publisher.publishChangeset({
      repository,
      branchName: crunchBranchName(run),
      title: `docs: crunch tidy (${run.plan.operations.length} operation${run.plan.operations.length === 1 ? "" : "s"})`,
      changes
    });
    const updatedRun = await ctx.stores.crunchRuns.recordRunPublication(run.id, {
      provider: "local-git",
      branchName: publication.branchName,
      commitSha: publication.commitSha,
      remoteUrl: publication.remoteUrl,
      publishedAt: new Date().toISOString()
    });

    return { ok: true as const, run: updatedRun, publication };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Crunch publish failed";
    return { ok: false as const, status: 409 as const, code: "crunch_publish_failed", message };
  }
}

// Always returns one settings row per configured flow (or a single default-flow
// row when no flows are configured), merging in any stored schedule so the UI
// can render a control even before the schedule has been saved once.
export async function settingsForResponse(ctx: AppContext) {
  const stored = await ctx.stores.crunchRuns.listSettings();
  const byFlow = new Map(stored.map((setting) => [setting.flowId ?? "", setting]));
  const fallback = (flowId: string | undefined) =>
    byFlow.get(flowId ?? "") ?? { flowId, enabled: false, cron: DEFAULT_CRUNCH_CRON };

  if (ctx.knowledgeConfig.flows.length > 0) {
    return ctx.knowledgeConfig.flows.map((flow) => fallback(flow.id));
  }

  return [fallback(undefined)];
}

export async function updateSettings(
  ctx: AppContext,
  flowId: string | undefined,
  settings: { enabled: boolean; cron: string }
): Promise<void> {
  await ctx.stores.crunchRuns.updateSettings(flowId, settings);
}
