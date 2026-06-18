import type {
  ChangesetChange,
  CrunchPlan,
  KnowledgeDocument,
  RankedSection,
  SourceChangeFile,
  SourceChangeSyncJobInput,
  SourceSyncCandidateDocument,
  SourceSyncRun,
  SourceSyncRunTrigger
} from "@magpie/core";
import { SOURCE_CHANGE_SYNC } from "@magpie/prompts";
import {
  LocalGitProposalPublisher,
  diffChangedFiles,
  ensureGitCheckout,
  getHeadSha,
  type SourceFileChange
} from "@magpie/git";
import type { AppContext } from "../../context.js";
import { changesetFromPlan, isCrunchPlan } from "../crunch/service.js";
import {
  checkoutRoot,
  defaultDestinationId,
  findRepositoryForDestination,
  selectFlow
} from "../../platform/repositories.js";
import type { ConfiguredKnowledgeRepository } from "../../stores/knowledge-repositories.js";
import { normalizeRelativePath } from "../../platform/paths.js";
import { parseJsonObject } from "../../platform/json.js";

// How many retrieved sections to consider, and how many distinct documents to
// hand the model as editable candidates. Kept small so the model sees only the
// documents most likely to describe the changed behaviour.
const RETRIEVAL_SECTION_LIMIT = 12;
const CANDIDATE_DOCUMENT_LIMIT = 6;
// The retrieval query (changed paths + diffs) is capped so a large commit can't
// blow up the embedding/keyword query.
const RETRIEVAL_QUERY_MAX_CHARS = 6_000;

// Watches every git source of a flow (or, with no flow, every configured git
// source) for new commits and reacts to each. Returns one run per source that
// actually had a new commit to consider; sources with no change since last time
// produce no run. Each source is independent — one failing source can't abort
// the others.
export async function triggerSourceSyncRun(
  ctx: AppContext,
  options: { flowId?: string; trigger: SourceSyncRunTrigger }
): Promise<SourceSyncRun[]> {
  const deps = ctx.repositoryDeps();
  const flow = selectFlow(deps, options.flowId);
  const flowId = flow?.id ?? options.flowId;
  const destinationId = flow?.destinationId ?? defaultDestinationId(deps);

  const sourceIds = flow ? flow.sourceIds : deps.knowledgeConfig.sources.map((source) => source.id);
  const sources = sourceIds
    .map((id) => deps.knowledgeConfig.sources.find((source) => source.id === id))
    .filter((source): source is ConfiguredKnowledgeRepository => Boolean(source) && source!.kind === "git" && Boolean(source!.url));

  const runs: SourceSyncRun[] = [];
  for (const source of sources) {
    try {
      const run = await syncGitSource(ctx, { flowId, destinationId, source, trigger: options.trigger });
      if (run) {
        runs.push(run);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "source sync failed";
      console.warn(`Source-change sync failed for source ${source.id} (flow ${flowId ?? "default"}): ${message}`);
    }
  }

  return runs;
}

async function syncGitSource(
  ctx: AppContext,
  args: {
    flowId: string | undefined;
    destinationId: string | undefined;
    source: ConfiguredKnowledgeRepository;
    trigger: SourceSyncRunTrigger;
  }
): Promise<SourceSyncRun | undefined> {
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
    // Not a usable git checkout (empty clone, detached, etc.) — nothing to do.
    return undefined;
  }

  const previous = await store.getState(flowId, source.id);
  if (!previous) {
    // First time we've seen this source: record a baseline so the *next* commit
    // is what we react to. Reacting to the entire history on first run would be
    // noise.
    await store.setState(flowId, source.id, headSha);
    console.log(`Source-change sync baselined ${source.id} (flow ${flowId ?? "default"}) at ${headSha.slice(0, 8)}.`);
    return undefined;
  }

  if (previous.lastSha === headSha) {
    return undefined; // No new commits.
  }

  const changes = await diffChangedFiles(checkout.localPath, previous.lastSha, headSha, { subpath: source.subpath });
  if (changes.length === 0) {
    // Commits landed but nothing inside the watched subpath changed.
    await store.setState(flowId, source.id, headSha);
    return undefined;
  }

  const candidateDocuments = selectCandidateDocuments(
    await ctx.stores.knowledgeIndex.search(buildRetrievalQuery(changes), RETRIEVAL_SECTION_LIMIT, destinationId ? [destinationId] : undefined),
    ctx.stores.knowledgeIndex.listDocuments(),
    CANDIDATE_DOCUMENT_LIMIT
  );

  // The "if the KB already contains that info" gate: with no document describing
  // the changed area, there is nothing to correct.
  if (candidateDocuments.length === 0) {
    const run = await store.createRun({
      flowId,
      destinationId,
      sourceId: source.id,
      trigger,
      status: "skipped",
      fromSha: previous.lastSha,
      toSha: headSha,
      changedFileCount: changes.length,
      candidateCount: 0
    });
    await store.setState(flowId, source.id, headSha);
    console.log(
      `Source-change sync for ${source.id}: ${changes.length} changed file(s) but no matching knowledge — skipped.`
    );
    return run;
  }

  const input: SourceChangeSyncJobInput = {
    flowId,
    destinationId,
    sourceId: source.id,
    sourceName: source.name,
    fromSha: previous.lastSha,
    toSha: headSha,
    changes: changes.map(toSourceChangeFile),
    candidateDocuments,
    expectedOutput: "crunch_plan"
  };

  let plan: CrunchPlan;
  try {
    plan = await generateSyncPlan(ctx, input);
  } catch (error) {
    const message = error instanceof Error ? error.message : "source sync planning failed";
    // Leave the baseline unchanged so a transient failure retries next tick.
    return store.createRun({
      flowId,
      destinationId,
      sourceId: source.id,
      trigger,
      status: "failed",
      error: message,
      fromSha: previous.lastSha,
      toSha: headSha,
      changedFileCount: changes.length,
      candidateCount: candidateDocuments.length
    });
  }

  // Defence-in-depth: only ever write back documents we offered as candidates,
  // and never delete — a source-sync corrects existing docs, it does not remove
  // knowledge.
  const changeset = constrainToCandidates(changesetFromPlan(plan), candidateDocuments);

  if (changeset.length === 0) {
    const run = await store.createRun({
      flowId,
      destinationId,
      sourceId: source.id,
      trigger,
      status: "skipped",
      plan,
      fromSha: previous.lastSha,
      toSha: headSha,
      changedFileCount: changes.length,
      candidateCount: candidateDocuments.length
    });
    await store.setState(flowId, source.id, headSha);
    return run;
  }

  const run = await store.createRun({
    flowId,
    destinationId,
    sourceId: source.id,
    trigger,
    status: "completed",
    plan,
    fromSha: previous.lastSha,
    toSha: headSha,
    changedFileCount: changes.length,
    candidateCount: candidateDocuments.length
  });

  // Advance the baseline now: the change has been planned and recorded, so we
  // should not re-plan it. A publish failure is surfaced on the run for the
  // operator to retry from, not by re-running the model.
  await store.setState(flowId, source.id, headSha);
  await publishRun(ctx, run, changeset, source.name);
  return (await store.getRun(run.id)) ?? run;
}

async function generateSyncPlan(ctx: AppContext, input: SourceChangeSyncJobInput): Promise<CrunchPlan> {
  if (ctx.config.get().aiProvider === "mock") {
    // The mock provider cannot reason about a diff; return a no-op plan so the
    // pipeline runs end-to-end in demos/tests without inventing edits.
    return {
      summary: "Mock provider does not generate source-sync edits.",
      operations: [],
      rationale: "mock"
    };
  }

  const response = await ctx.providers.chat(ctx.config.get().aiProvider).complete({
    system: SOURCE_CHANGE_SYNC.instructions,
    messages: [{ role: "user", content: JSON.stringify(input, null, 2) }]
  });
  const output = parseJsonObject(response.content);
  if (!isCrunchPlan(output)) {
    throw new Error("Direct source-sync provider returned invalid plan output");
  }
  return output;
}

async function publishRun(
  ctx: AppContext,
  run: SourceSyncRun,
  changeset: ChangesetChange[],
  sourceName: string
): Promise<void> {
  const repository = await findRepositoryForDestination(ctx.repositoryDeps(), run.destinationId);
  if (!repository) {
    console.warn(`Source-sync run ${run.id}: no indexed repository for destination ${run.destinationId ?? "default"}; left unpublished.`);
    return;
  }
  if (repository.git?.scope === "not-git" || !repository.git?.workTreeRoot) {
    console.warn(`Source-sync run ${run.id}: destination is not a git checkout; left unpublished.`);
    return;
  }

  try {
    const publisher = new LocalGitProposalPublisher();
    const publication = await publisher.publishChangeset({
      repository,
      branchName: sourceSyncBranchName(run),
      title: `docs: sync to ${sourceName} change (${changeset.length} document${changeset.length === 1 ? "" : "s"})`,
      changes: changeset
    });
    await ctx.stores.sourceSync.recordRunPublication(run.id, {
      provider: "local-git",
      branchName: publication.branchName,
      commitSha: publication.commitSha,
      remoteUrl: publication.remoteUrl,
      publishedAt: new Date().toISOString()
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "source-sync publish failed";
    console.warn(`Source-sync run ${run.id} could not publish: ${message}`);
  }
}

function sourceSyncBranchName(run: SourceSyncRun): string {
  return `magpie/source-sync-${run.id.slice(0, 8)}`;
}

// --- Pure helpers (unit-tested) --------------------------------------------

// Builds the retrieval query from the changed files: paths plus their diffs,
// truncated so a large commit can't produce an unbounded query.
export function buildRetrievalQuery(changes: SourceFileChange[]): string {
  const query = changes.map((change) => `${change.path}\n${change.diff}`).join("\n\n");
  return query.length > RETRIEVAL_QUERY_MAX_CHARS ? query.slice(0, RETRIEVAL_QUERY_MAX_CHARS) : query;
}

// Collapses ranked sections into the distinct documents they belong to, in rank
// order, capped at `limit`. These are the only documents the model may edit.
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

// Keeps only writes that target a candidate document, dropping deletes and any
// path the model invented outside the set it was given.
export function constrainToCandidates(
  changes: ChangesetChange[],
  candidateDocuments: SourceSyncCandidateDocument[]
): ChangesetChange[] {
  const allowed = new Set(candidateDocuments.map((document) => normalizeRelativePath(document.path)));
  return changes.filter((change) => !change.delete && allowed.has(normalizeRelativePath(change.path)));
}

function toSourceChangeFile(change: SourceFileChange): SourceChangeFile {
  return { path: change.path, status: change.status, diff: change.diff };
}
