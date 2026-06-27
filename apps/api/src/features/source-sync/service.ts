import type {
  ChangesetChange,
  KnowledgeDocument,
  MaintenancePlan,
  MaintenanceRun,
  Proposal,
  RankedSection,
  SourceChangeFile,
  SourceChangeSyncJobInput,
  SourceSyncCandidateDocument
} from "@magpie/core";
import type { JobView } from "@magpie/jobs";
import {
  syncSourceChangesGeneratePlanInputSchema,
  syncSourceChangesGeneratePlanOutputSchema
} from "@magpie/jobs";
import {
  diffChangedFiles,
  ensureGitCheckout,
  getHeadSha,
  type SourceFileChange
} from "@magpie/git";
import type { AppContext } from "../../context.js";
import {
  checkoutRoot,
  defaultDestinationId,
  selectFlow
} from "../../platform/repositories.js";
import { normalizeRelativePath } from "../../platform/paths.js";
import { type AiProviderName } from "../../platform/providers.js";
import type { ConfiguredKnowledgeRepository } from "../../stores/knowledge-repositories.js";

const RETRIEVAL_SECTION_LIMIT = 12;
const CANDIDATE_DOCUMENT_LIMIT = 6;
const RETRIEVAL_QUERY_MAX_CHARS = 6_000;

export interface SourceSyncTriggerResult {
  maintenanceRunIds: string[];
  proposalIds: string[];
}

interface SourceSyncPlanJobMeta extends SourceChangeSyncJobInput {
  provider: AiProviderName;
}

export async function triggerSourceSyncRun(
  ctx: AppContext,
  options: { flowId?: string; trigger: MaintenanceRun["trigger"] }
): Promise<SourceSyncTriggerResult> {
  const deps = ctx.repositoryDeps();
  const flow = selectFlow(deps, options.flowId);
  const flowId = flow?.id ?? options.flowId;
  const destinationId = flow?.destinationId ?? defaultDestinationId(deps);

  const sourceIds = flow ? flow.sourceIds : deps.knowledgeConfig.sources.map((source) => source.id);
  const sources = sourceIds
    .map((id) => deps.knowledgeConfig.sources.find((source) => source.id === id))
    .filter((source): source is ConfiguredKnowledgeRepository => Boolean(source) && source!.kind === "git" && Boolean(source!.url));

  const result: SourceSyncTriggerResult = { maintenanceRunIds: [], proposalIds: [] };
  for (const source of sources) {
    try {
      const sourceResult = await syncGitSource(ctx, { flowId, destinationId, source, trigger: options.trigger });
      if (sourceResult?.maintenanceRunId) {
        result.maintenanceRunIds.push(sourceResult.maintenanceRunId);
      }
      if (sourceResult?.proposalId) {
        result.proposalIds.push(sourceResult.proposalId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "source sync failed";
      console.warn(`Source-change sync failed for source ${source.id} (flow ${flowId ?? "default"}): ${message}`);
    }
  }

  return result;
}

async function syncGitSource(
  ctx: AppContext,
  args: {
    flowId: string | undefined;
    destinationId: string | undefined;
    source: ConfiguredKnowledgeRepository;
    trigger: MaintenanceRun["trigger"];
  }
): Promise<{ maintenanceRunId?: string; proposalId?: string } | undefined> {
  const { flowId, destinationId, source, trigger } = args;
  const store = ctx.stores.sourceSync;

  const checkout = await ensureGitCheckout({
    id: source.id,
    url: source.url!,
    branch: source.branch,
    checkoutRoot: checkoutRoot()
  });
  const headSha = await getHeadSha(checkout.localPath);
  if (!headSha) {
    return undefined;
  }

  const previous = await store.getState(flowId, source.id);
  if (!previous) {
    await store.setState(flowId, source.id, headSha);
    console.log(`Source-change sync baselined ${source.id} (flow ${flowId ?? "default"}) at ${headSha.slice(0, 8)}.`);
    return undefined;
  }

  if (previous.lastSha === headSha) {
    return undefined;
  }

  const changes = await diffChangedFiles(checkout.localPath, previous.lastSha, headSha, { subpath: source.subpath });
  if (changes.length === 0) {
    await store.setState(flowId, source.id, headSha);
    return undefined;
  }

  const candidateDocuments = selectCandidateDocuments(
    await ctx.stores.knowledgeIndex.search(buildRetrievalQuery(changes), RETRIEVAL_SECTION_LIMIT, destinationId ? [destinationId] : undefined),
    ctx.stores.knowledgeIndex.listDocuments(),
    CANDIDATE_DOCUMENT_LIMIT
  );

  await store.setState(flowId, source.id, headSha);

  if (candidateDocuments.length === 0) {
    const run = await recordSourceSyncMaintenanceRun(ctx, {
      flowId,
      destinationId,
      sourceId: source.id,
      sourceName: source.name,
      fromSha: previous.lastSha,
      toSha: headSha,
      changes: changes.map(toSourceChangeFile),
      candidateDocuments
    }, {
      trigger,
      status: "completed",
      summary: `checked ${source.name} ${previous.lastSha.slice(0, 8)}..${headSha.slice(0, 8)} · no candidate docs`,
      proposalIds: []
    });
    return { maintenanceRunId: run.id };
  }

  const input: SourceSyncPlanJobMeta = {
    flowId,
    destinationId,
    sourceId: source.id,
    sourceName: source.name,
    fromSha: previous.lastSha,
    toSha: headSha,
    changes: changes.map(toSourceChangeFile),
    candidateDocuments,
    provider: ctx.config.get().aiProvider,
    expectedOutput: "maintenance_plan"
  };

  const job = await ctx.jobs.create("sync_source_changes_generate_plan", input);
  console.log(
    `Source-change sync for ${source.id}: enqueued plan job ${job.id} over ${changes.length} changed file(s) ` +
      `with ${candidateDocuments.length} candidate(s).`
  );
  return undefined;
}

export async function createSourceSyncProposalFromCompletedJob(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<{ proposal?: Proposal; maintenanceRun?: MaintenanceRun } | undefined> {
  if (!job || job.type !== "sync_source_changes_generate_plan") {
    return undefined;
  }

  const input = syncSourceChangesGeneratePlanInputSchema.safeParse(job.input);
  const parsed = syncSourceChangesGeneratePlanOutputSchema.safeParse(output);
  if (!input.success) {
    return undefined;
  }
  const meta = input.data;

  if (!parsed.success) {
    const maintenanceRun = await recordSourceSyncMaintenanceRun(ctx, meta, {
      trigger: "scheduled",
      status: "failed",
      summary: `source-sync plan malformed for ${meta.sourceName}`,
      proposalIds: [],
      jobId: job.id,
      error: "source-sync plan job returned malformed output"
    });
    return { maintenanceRun };
  }

  const changeset = constrainToCandidates(changesetFromPlan(parsed.data), meta.candidateDocuments);
  if (changeset.length === 0) {
    const maintenanceRun = await recordSourceSyncMaintenanceRun(ctx, meta, {
      trigger: "scheduled",
      status: "completed",
      summary: `checked ${meta.sourceName} ${meta.fromSha.slice(0, 8)}..${meta.toSha.slice(0, 8)} · no document changes`,
      proposalIds: [],
      jobId: job.id
    });
    return { maintenanceRun };
  }

  const primary = changeset.find((change) => change.content !== undefined);
  if (!primary?.content) {
    const maintenanceRun = await recordSourceSyncMaintenanceRun(ctx, meta, {
      trigger: "scheduled",
      status: "completed",
      summary: `checked ${meta.sourceName} ${meta.fromSha.slice(0, 8)}..${meta.toSha.slice(0, 8)} · no writable primary document`,
      proposalIds: [],
      jobId: job.id
    });
    return { maintenanceRun };
  }

  const proposal = await ctx.stores.proposals.create({
    title: `Source sync: ${meta.sourceName} ${meta.fromSha.slice(0, 8)}..${meta.toSha.slice(0, 8)}`,
    targetPath: primary.path,
    markdown: primary.content,
    changeset,
    rationale: `${parsed.data.rationale}\n\nSource ${meta.sourceName}: ${meta.fromSha}..${meta.toSha}`,
    evidence: [],
    flowId: meta.flowId,
    destinationId: meta.destinationId,
    jobId: job.id,
    draftContext: {
      gapSummaries: [],
      sourceFiles: meta.changes.map((change) => ({ sourceName: meta.sourceName, path: change.path })),
      evidenceCount: meta.candidateDocuments.length,
      openPullRequests: []
    }
  });

  const maintenanceRun = await recordSourceSyncMaintenanceRun(ctx, meta, {
    trigger: "scheduled",
    status: "completed",
    summary: `checked ${meta.sourceName} ${meta.fromSha.slice(0, 8)}..${meta.toSha.slice(0, 8)} · created proposal`,
    proposalIds: [proposal.id],
    jobId: job.id
  });

  return { proposal, maintenanceRun };
}

export async function recordSourceSyncFailureFromFailedJob(
  ctx: AppContext,
  job: JobView | undefined,
  error: string
): Promise<MaintenanceRun | undefined> {
  if (!job || job.type !== "sync_source_changes_generate_plan") {
    return undefined;
  }
  const input = syncSourceChangesGeneratePlanInputSchema.safeParse(job.input);
  if (!input.success) {
    return undefined;
  }
  return recordSourceSyncMaintenanceRun(ctx, input.data, {
    trigger: "scheduled",
    status: "failed",
    summary: `source-sync plan failed for ${input.data.sourceName}`,
    proposalIds: [],
    jobId: job.id,
    error
  });
}

async function recordSourceSyncMaintenanceRun(
  ctx: AppContext,
  meta: Omit<SourceChangeSyncJobInput, "expectedOutput">,
  options: {
    trigger: MaintenanceRun["trigger"];
    status: MaintenanceRun["status"];
    summary: string;
    proposalIds: string[];
    jobId?: string;
    error?: string;
  }
): Promise<MaintenanceRun> {
  return ctx.stores.maintenanceRuns.record({
    taskType: "source_change_sync",
    flowId: meta.flowId,
    trigger: options.trigger,
    status: options.status,
    summary: options.summary,
    error: options.error,
    details: {
      sourceId: meta.sourceId,
      sourceName: meta.sourceName,
      destinationId: meta.destinationId,
      fromSha: meta.fromSha,
      toSha: meta.toSha,
      changedFileCount: meta.changes.length,
      candidateCount: meta.candidateDocuments.length,
      proposalIds: options.proposalIds,
      ...(options.jobId ? { jobId: options.jobId } : {})
    }
  });
}

export function buildRetrievalQuery(changes: SourceFileChange[]): string {
  const query = changes.map((change) => `${change.path}\n${change.diff}`).join("\n\n");
  return query.length > RETRIEVAL_QUERY_MAX_CHARS ? query.slice(0, RETRIEVAL_QUERY_MAX_CHARS) : query;
}

export function selectCandidateDocuments(
  ranked: RankedSection[],
  documents: KnowledgeDocument[],
  limit: number
): SourceSyncCandidateDocument[] {
  const byId = new Map(documents.map((document) => [document.id, document]));
  const seen = new Set<string>();
  const candidates: SourceSyncCandidateDocument[] = [];

  for (const { section } of ranked) {
    const document = byId.get(section.documentId);
    if (!document || seen.has(document.id)) {
      continue;
    }
    seen.add(document.id);
    candidates.push({ path: document.path, content: document.content });
    if (candidates.length >= limit) {
      break;
    }
  }

  return candidates;
}

export function constrainToCandidates(
  changes: ChangesetChange[],
  candidateDocuments: SourceSyncCandidateDocument[]
): ChangesetChange[] {
  const allowed = new Set(candidateDocuments.map((document) => normalizeRelativePath(document.path)));
  return changes.filter((change) => !change.delete && allowed.has(normalizeRelativePath(change.path)));
}

export function changesetFromPlan(plan: MaintenancePlan): ChangesetChange[] {
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

function toSourceChangeFile(change: SourceFileChange): SourceChangeFile {
  return { path: change.path, status: change.status, diff: change.diff };
}
