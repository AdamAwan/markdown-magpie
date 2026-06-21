import type {
  ChangesetChange,
  CrunchKnowledgeBaseJobInput,
  CrunchPlan,
  CrunchRun,
  CrunchRunTrigger,
  RepositoryRef
} from "@magpie/core";
import type { JobView } from "@magpie/jobs";
import { z } from "zod";
import { publishCrunchOutputSchema } from "@magpie/jobs";
import type { AppContext } from "../../context.js";
import { DEFAULT_CRUNCH_CRON } from "../../stores/crunch-store.js";
import { defaultDestinationId, findRepositoryForDestination, selectFlow } from "../../platform/repositories.js";
import { normalizeRelativePath } from "../../platform/paths.js";
import { type AiProviderName } from "../../platform/providers.js";

type PublishCrunchJobOutput = z.infer<typeof publishCrunchOutputSchema>;

export async function listRuns(ctx: AppContext, limit: number): Promise<CrunchRun[]> {
  return ctx.stores.crunchRuns.listRuns(limit);
}

export async function getRun(ctx: AppContext, id: string): Promise<CrunchRun | undefined> {
  return ctx.stores.crunchRuns.getRun(id);
}

// Shared by the manual trigger endpoint and the scheduler. Planning is
// enqueue-only: both the manual trigger and the scheduler create a "running" run
// linked to a crunch_knowledge_base job and return immediately, so neither the
// HTTP response nor the scheduler tick blocks on the (potentially slow) model
// call. The watcher runs the generative work and completes the run via
// attachCrunchPlanFromCompletedJob().
export async function triggerCrunchRun(
  ctx: AppContext,
  options: { flowId?: string; trigger: CrunchRunTrigger }
): Promise<CrunchRun> {
  const deps = ctx.repositoryDeps();
  const flow = selectFlow(deps, options.flowId);
  const flowId = flow?.id ?? options.flowId;
  const destinationId = flow?.destinationId ?? defaultDestinationId(deps);
  const documents = gatherCrunchDocuments(ctx, destinationId);
  // The configured provider is passed through as-is; the @magpie/jobs contract
  // validates it.
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
      `provider=${ctx.config.get().aiProvider})`
  );

  const job = await ctx.jobs.create("crunch_knowledge_base", input);
  return ctx.stores.crunchRuns.createRun({
    flowId,
    destinationId,
    trigger: options.trigger,
    documentCount: documents.length,
    status: "running",
    jobId: job.id
  });
}

function gatherCrunchDocuments(ctx: AppContext, destinationId: string | undefined) {
  const documents = ctx.stores.knowledgeIndex.listDocuments();
  const scoped = destinationId ? documents.filter((document) => document.repositoryId === destinationId) : documents;
  return scoped.map((document) => ({ path: document.path, content: document.content }));
}

export async function attachCrunchPlanFromCompletedJob(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<void> {
  if (!job || job.type !== "crunch_knowledge_base") {
    return;
  }

  const run = await ctx.stores.crunchRuns.getRunByJobId(job.id);
  if (!run) {
    return;
  }

  if (run.status === "completed" || run.status === "published") return;

  if (isCrunchPlan(output)) {
    await ctx.stores.crunchRuns.completeRun(run.id, output);
  } else {
    await ctx.stores.crunchRuns.failRun(run.id, "Crunch job returned an invalid plan");
  }
}

// Completion handler for publish_crunch jobs: records the validated git
// publication the watcher performed (branch, commit, optional remote url) onto
// the linked run. Idempotent by runId — a run that already carries a publication
// is left untouched, so re-completing the same job never double-applies or
// regresses the recorded metadata. Crunch raises no PR, so there is no
// pullRequestUrl.
export async function recordCrunchPublicationFromCompletedJob(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<CrunchRun | undefined> {
  if (!job || job.type !== "publish_crunch" || !isPublishCrunchJobOutput(output)) {
    return undefined;
  }

  const existing = await ctx.stores.crunchRuns.getRun(output.runId);
  if (!existing) {
    return undefined;
  }
  if (existing.publication) {
    return existing;
  }

  return ctx.stores.crunchRuns.recordRunPublication(output.runId, {
    provider: "local-git",
    branchName: output.branchName,
    commitSha: output.commitSha,
    remoteUrl: output.remoteUrl,
    publishedAt: output.publishedAt
  });
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

function isPublishCrunchJobOutput(value: unknown): value is PublishCrunchJobOutput {
  return publishCrunchOutputSchema.safeParse(value).success;
}

// Flattens a plan's operations into a single de-duplicated changeset. Deletes are
// applied first, then writes, so a path that is both deleted and (re)written ends
// up as a write — a split that reuses the original path stays a write, not a
// delete. Pure: exported so the Task 7 publication runner derives the same
// changeset the API validated.
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

// Pure: the branch a crunch run publishes onto. Exported so the Task 7
// publication runner derives the same branch name the API used to before git
// moved out.
export function crunchBranchName(run: CrunchRun): string {
  return `magpie/crunch-${run.id.slice(0, 8)}`;
}

type PublishValidationError = {
  ok: false;
  status: 404 | 409;
  code:
    | "crunch_run_not_found"
    | "crunch_run_not_publishable"
    | "crunch_run_empty_plan"
    | "crunch_repository_not_found"
    | "crunch_repository_not_git";
  message?: string;
};

// Resolves and validates that a run is publishable and that its destination maps
// to a Git checkout. This is the shared pre-flight that both the publish enqueue
// path and the execution-context endpoint run, so an invalid publish fails fast
// with the same status before any job is enqueued or handed to the watcher.
async function resolvePublishRepository(
  ctx: AppContext,
  runId: string
): Promise<{ ok: true; run: CrunchRun; repository: RepositoryRef } | PublishValidationError> {
  const run = await ctx.stores.crunchRuns.getRun(runId);
  if (!run) {
    return { ok: false, status: 404, code: "crunch_run_not_found" };
  }

  if (run.status !== "completed" || !run.plan) {
    return {
      ok: false,
      status: 409,
      code: "crunch_run_not_publishable",
      message: "Only completed crunch runs with a plan can be published."
    };
  }

  if (changesetFromPlan(run.plan).length === 0) {
    return {
      ok: false,
      status: 409,
      code: "crunch_run_empty_plan",
      message: "This crunch plan does not change any files."
    };
  }

  const repository = await findRepositoryForDestination(ctx.repositoryDeps(), run.destinationId);
  if (!repository) {
    return {
      ok: false,
      status: 409,
      code: "crunch_repository_not_found",
      message: "No indexed Git repository matches this crunch run's destination."
    };
  }

  if (repository.git?.scope === "not-git" || !repository.git?.workTreeRoot) {
    return {
      ok: false,
      status: 409,
      code: "crunch_repository_not_git",
      message: "The matched repository is not a Git checkout."
    };
  }

  return { ok: true, run, repository };
}

// Enqueues a publish_crunch job for a completed crunch run after running the
// repository pre-flight. Git execution now happens in the Task 7 watcher runner
// (which fetches the execution context and reuses the pure changeset / branch-name
// helpers exported here); the API only validates and enqueues, so an
// unpublishable run still fails fast with the original 404/409 codes before any
// job exists. Crunch publish raises no PR.
export async function publishRun(
  ctx: AppContext,
  runId: string
): Promise<{ ok: true; job: JobView } | PublishValidationError> {
  const resolved = await resolvePublishRepository(ctx, runId);
  if (!resolved.ok) {
    return resolved;
  }

  const job = await ctx.jobs.create("publish_crunch", { runId });
  console.log(`Enqueued publish_crunch job ${job.id} for crunch run ${runId}`);
  return { ok: true, job };
}

type ExecutionContextRepository = Pick<RepositoryRef, "id" | "localPath" | "remoteUrl" | "defaultBranch" | "git">;

// The non-generative, credential-free view the Task 7 publication runner fetches
// before executing git: the run record plus exactly the repository fields it
// needs to push a branch. Runs the same resolution + validation as the publish
// path, so it returns the same 404/409 conditions.
export async function getRunExecutionContext(
  ctx: AppContext,
  runId: string
): Promise<{ ok: true; run: CrunchRun; repository: ExecutionContextRepository } | PublishValidationError> {
  const resolved = await resolvePublishRepository(ctx, runId);
  if (!resolved.ok) {
    return resolved;
  }

  const { id, localPath, remoteUrl, defaultBranch, git } = resolved.repository;
  return { ok: true, run: resolved.run, repository: { id, localPath, remoteUrl, defaultBranch, git } };
}

// Always returns one settings row per configured flow (or a single default-flow
// row when no flows are configured), merging in any stored schedule so the UI
// can render a control even before the schedule has been saved once.
export async function settingsForResponse(ctx: AppContext) {
  const stored = await ctx.stores.crunchRuns.listSettings();
  const byFlow = new Map(stored.map((setting) => [setting.flowId ?? "", setting]));
  // Next-run timing is owned by pg-boss now; join it in by the reconciler's
  // stable per-flow schedule key (`flow:<flowId|default>`).
  const schedules = await ctx.jobs.listSchedules();
  const nextRunByKey = new Map(schedules.map((schedule) => [schedule.key, schedule.nextRunAt]));
  const fallback = (flowId: string | undefined) => {
    const setting = byFlow.get(flowId ?? "") ?? { flowId, enabled: false, cron: DEFAULT_CRUNCH_CRON };
    return { ...setting, nextRunAt: nextRunByKey.get(`flow:${flowId ?? "default"}`) };
  };

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
