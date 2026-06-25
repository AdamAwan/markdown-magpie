import type {
  CorrectDocumentJobInput,
  DedupeDocumentsJobInput,
  DraftContext,
  DraftMarkdownProposalJobInput,
  DraftMarkdownProposalJobOutput,
  GapCandidate,
  OpenPullRequestContext,
  Proposal,
  RepositoryRef,
  SourceDataContext
} from "@magpie/core";
import type { JobView } from "@magpie/jobs";
import { z } from "zod";
import { correctDocumentOutputSchema, dedupeDocumentsOutputSchema, publishProposalOutputSchema } from "@magpie/jobs";
import { resolveProposalTargetPath } from "@magpie/core";
import type { AppContext } from "../../context.js";
import type { ProposalListOptions } from "../../stores/proposal-store.js";
import {
  defaultDestinationId,
  destinationSubpath,
  findRepositoryForProposal,
  resolveConfiguredRepositoryLocalPath,
  selectDestinationForProposal,
  selectFlow
} from "../../platform/repositories.js";
import { collectSourceContext } from "../../platform/source-context.js";
import { type AiProviderName } from "../../platform/providers.js";

type PublishProposalJobOutput = z.infer<typeof publishProposalOutputSchema>;

export async function list(ctx: AppContext, limit: number, options?: ProposalListOptions): Promise<Proposal[]> {
  return ctx.stores.proposals.list(limit, options);
}

export async function get(ctx: AppContext, id: string): Promise<Proposal | undefined> {
  return ctx.stores.proposals.get(id);
}

export async function updateStatus(
  ctx: AppContext,
  id: string,
  status: Proposal["status"]
): Promise<Proposal | undefined> {
  return ctx.stores.proposals.updateStatus(id, status);
}

// The work that must happen once a proposal is merged, shared by the manual
// "Mark merged" endpoint and the pull-request poller: resolve its gaps and
// re-index the destination knowledge base.
export async function runMergeCascade(
  ctx: AppContext,
  proposal: Proposal
): Promise<{ resolvedGapCount: number; reindexed: boolean }> {
  const resolvedGapCount = await resolveGapsForMergedProposal(ctx, proposal);
  const reindexed = await reindexDestinationForProposal(ctx, proposal);
  return { resolvedGapCount, reindexed };
}

// Resolves the gaps a merged proposal closed: precisely the rows whose question
// and summary the proposal recorded, so unrelated gaps on a multi-topic question
// are left untouched. Returns the number of gaps newly resolved.
async function resolveGapsForMergedProposal(ctx: AppContext, proposal: Proposal): Promise<number> {
  const questionIds = proposal.triggeringQuestionIds ?? [];
  const summaries = splitGapSummaries(proposal.gapSummary);
  if (questionIds.length === 0 || summaries.length === 0) {
    return 0;
  }

  const resolved = await ctx.stores.questionLogs.resolveGaps(questionIds, summaries, proposal.id);
  console.log(`Resolved ${resolved} gap(s) closed by merged proposal ${proposal.id}`);
  return resolved;
}

// Pulls the destination's default branch (where the PR merged) and re-indexes it
// so the merged document is immediately searchable. Best-effort: a failure here
// must not undo the merge, so it is logged and reported rather than thrown.
async function reindexDestinationForProposal(ctx: AppContext, proposal: Proposal): Promise<boolean> {
  try {
    if (ctx.knowledgeConfig.destinations.length > 0) {
      const destination = selectDestinationForProposal(ctx.repositoryDeps(), proposal);
      if (!destination) {
        console.warn(`No destination matched merged proposal ${proposal.id}; skipping re-index.`);
        return false;
      }

      // For a git destination this also fetches and fast-forwards the checkout,
      // bringing in the just-merged commit before we re-index.
      const localPath = await resolveConfiguredRepositoryLocalPath(destination);
      await ctx.stores.knowledgeIndex.indexLocalRepository({
        localPath,
        repositoryId: destination.id,
        name: destination.name
      });
    } else {
      const repository = await findRepositoryForProposal(ctx.repositoryDeps(), proposal);
      if (!repository) {
        console.warn(`No repository matched merged proposal ${proposal.id}; skipping re-index.`);
        return false;
      }

      await ctx.stores.knowledgeIndex.indexLocalRepository({
        localPath: repository.localPath,
        repositoryId: repository.id,
        name: repository.name
      });
    }

    console.log(`Re-indexed destination after merging proposal ${proposal.id}`);
    void ctx.embedder.trigger();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.warn(`Re-index after merging proposal ${proposal.id} failed: ${message}`);
    return false;
  }
}

type PublishValidationError = {
  ok: false;
  code: "proposal_repository_not_found" | "proposal_repository_not_git";
  message: string;
};

// Resolves and validates the Git repository a proposal would publish into. This
// is the shared pre-flight that both the publish enqueue path and the
// execution-context endpoint run, so an invalid publish fails fast with the same
// status before any job is enqueued or handed to the watcher.
async function resolvePublishRepository(
  ctx: AppContext,
  proposal: Proposal
): Promise<{ ok: true; repository: RepositoryRef } | PublishValidationError> {
  const repository = await findRepositoryForProposal(ctx.repositoryDeps(), proposal);
  if (!repository) {
    return {
      ok: false,
      code: "proposal_repository_not_found",
      message: "No indexed Git repository matches this proposal target path."
    };
  }

  if (repository.git?.scope === "not-git" || !repository.git?.workTreeRoot) {
    return {
      ok: false,
      code: "proposal_repository_not_git",
      message: "The matched repository is not a Git checkout."
    };
  }

  return { ok: true, repository };
}

// Enqueues a publish_proposal job for a "ready" proposal after re-running the
// same repository pre-flight the synchronous publish used. Git execution now
// happens in the Task 7 watcher runner (which fetches the execution context and
// reuses the pure branch-name / PR-body helpers exported here); the API only
// validates and enqueues, so an unpublishable proposal still fails fast with the
// original 404/409 codes before any job exists.
export async function requestProposalPublication(
  ctx: AppContext,
  proposal: Proposal
): Promise<{ ok: true; job: JobView } | PublishValidationError> {
  const resolved = await resolvePublishRepository(ctx, proposal);
  if (!resolved.ok) {
    return resolved;
  }

  const job = await ctx.jobs.create("publish_proposal", { proposalId: proposal.id });
  console.log(`Enqueued publish_proposal job ${job.id} for proposal ${proposal.id}`);
  return { ok: true, job };
}

type ExecutionContextRepository = Pick<RepositoryRef, "id" | "localPath" | "remoteUrl" | "defaultBranch" | "git">;

// The non-generative, credential-free view the Task 7 publication runner fetches
// before executing git: the proposal record plus exactly the repository fields it
// needs to push a branch and open a PR. Runs the same repository resolution +
// validation as the publish path, so it returns the same 404/409 conditions.
export async function getProposalExecutionContext(
  ctx: AppContext,
  proposalId: string
): Promise<
  | { ok: true; proposal: Proposal; repository: ExecutionContextRepository }
  | { ok: false; code: "proposal_not_found"; message: string }
  | PublishValidationError
> {
  const proposal = await ctx.stores.proposals.get(proposalId);
  if (!proposal) {
    return { ok: false, code: "proposal_not_found", message: "Proposal not found." };
  }

  const resolved = await resolvePublishRepository(ctx, proposal);
  if (!resolved.ok) {
    return resolved;
  }

  const { id, localPath, remoteUrl, defaultBranch, git } = resolved.repository;
  return { ok: true, proposal, repository: { id, localPath, remoteUrl, defaultBranch, git } };
}

// Drafts ONE proposal from one or more gap candidates. The reviewer (via the
// clustering UI) decides which gaps belong together, so this accepts either a
// single `summary` (legacy /from-gap) or a `summaries` array (a confirmed
// cluster from /from-gaps). Evidence and triggering questions are unioned across
// every gap in the cluster so the drafter sees the full picture once.
// Core of "draft one proposal from a confirmed cluster of gap summaries",
// independent of HTTP so the scheduled gap-to-PR task can reuse it. Enqueues a
// draft_markdown_proposal job; the proposal lands later via the job completion
// machinery (createProposalFromCompletedJob).
// A per-run memo of collected source context, keyed by the resolved source-id
// set. Collecting a source walks its checkout and reads up to 24 files, and that
// material is identical for every proposal drawn from the same sources — so a
// reconcile run drafting dozens of proposals would otherwise re-collect the same
// bytes dozens of times. Callers that draft in a loop pass one cache through.
export type SourceContextCache = Map<string, SourceDataContext[]>;

// In-flight statuses whose proposals a new draft should be aware of: an open PR
// (pr-opened) plus the earlier stages that have no PR yet but are still work the
// drafter shouldn't duplicate. Terminal statuses (merged/rejected/superseded)
// are excluded — that work is settled.
const IN_FLIGHT_PROPOSAL_STATUSES: ReadonlyArray<Proposal["status"]> = [
  "draft",
  "ready",
  "branch-pushed",
  "pr-opened"
];

// Reads the flow's on-disk snapshot and returns its in-flight proposals / open
// pull requests as drafting context. Deliberately off the network — it uses only
// the PR state the fetch job already downloaded — so the reconciler stays offline
// during drafting (see the fetch/process split). Returns [] when no snapshot
// exists yet, so callers degrade gracefully to no open-PR context. Pass
// excludeClusterId to drop the cluster's own in-flight proposal so a draft never
// sees its own PR.
export async function collectOpenPullRequestContext(
  ctx: AppContext,
  flowId: string | undefined,
  options: { excludeClusterId?: string } = {}
): Promise<OpenPullRequestContext[]> {
  const snapshot = await ctx.stores.snapshots.read(flowId);
  if (!snapshot) {
    return [];
  }
  // A PR the snapshot already knows is merged or closed is not "currently open",
  // so drop it even if a stale snapshot still records the proposal as pr-opened.
  const closedProposalIds = new Set(
    snapshot.pullRequests.filter((pr) => pr.merged || pr.state === "closed").map((pr) => pr.proposalId)
  );
  // Target paths aren't carried in the snapshot; recover them from the proposal
  // store (local DB, not the host) so the drafter can see what each PR touches.
  const storedById = new Map((await ctx.stores.proposals.list(500)).map((proposal) => [proposal.id, proposal]));

  const result: OpenPullRequestContext[] = [];
  for (const proposal of snapshot.proposals) {
    if (!IN_FLIGHT_PROPOSAL_STATUSES.includes(proposal.status)) {
      continue;
    }
    if (options.excludeClusterId && proposal.gapClusterId === options.excludeClusterId) {
      continue;
    }
    if (closedProposalIds.has(proposal.id)) {
      continue;
    }
    const stored = storedById.get(proposal.id);
    result.push({
      title: proposal.title ?? stored?.title ?? "(untitled proposal)",
      url: proposal.pullRequestUrl ?? stored?.publication?.pullRequestUrl,
      targetPath: stored?.targetPath,
      status: proposal.status
    });
  }
  return result;
}

// Distils the inputs handed to the drafter into the compact, inspectable record
// kept on the proposal. Records source-file identities (name/path/url) but not
// their bodies, which can be large and are already captured elsewhere.
function buildDraftContext(parts: {
  gapSummaries: string[];
  sourceContext?: SourceDataContext[];
  evidence: Proposal["evidence"];
  openPullRequests?: OpenPullRequestContext[];
}): DraftContext {
  return {
    gapSummaries: parts.gapSummaries,
    sourceFiles: (parts.sourceContext ?? [])
      .filter((source) => source.path || source.url)
      .map((source) => ({ sourceName: source.sourceName, path: source.path, url: source.url })),
    evidenceCount: parts.evidence.length,
    openPullRequests: parts.openPullRequests ?? []
  };
}

export async function draftFromGaps(
  ctx: AppContext,
  rawSummaries: string[],
  overrides: {
    targetPath?: string;
    flowId?: string;
    sourceIds?: string[];
    destinationId?: string;
    sourceContextCache?: SourceContextCache;
    // The flow's in-flight proposals / open PRs to make the drafter aware of.
    // Optional and defaults to none, so the on-demand HTTP path stays unchanged.
    openPullRequests?: OpenPullRequestContext[];
    // The cluster this draft belongs to, threaded onto the job so the completed
    // proposal links back to it. Absent on the on-demand path.
    gapClusterId?: string;
  } = {}
) {
  const uniqueRequested = [...new Set(rawSummaries.map((value) => value.trim()).filter((value) => value.length > 0))];

  if (uniqueRequested.length === 0) {
    return { ok: false as const, code: "gap_summary_required" };
  }

  const candidates = await ctx.stores.questionLogs.listGapCandidates(200);
  const matched = uniqueRequested
    .map((summary) => candidates.find((candidate) => candidate.summary === summary))
    .filter((candidate): candidate is GapCandidate => Boolean(candidate));

  if (matched.length === 0) {
    return { ok: false as const, code: "gap_candidate_not_found" };
  }

  const gapSummaries = matched.map((candidate) => candidate.summary);
  const questionIds = [...new Set(matched.flatMap((candidate) => candidate.questionIds))];
  const label = gapSummaries.length === 1 ? `gap "${gapSummaries[0]}"` : `${gapSummaries.length} clustered gaps`;

  const logs = (await Promise.all(questionIds.map((id) => ctx.stores.questionLogs.get(id)))).filter(
    (log): log is NonNullable<typeof log> => Boolean(log)
  );
  const evidence = dedupeCitations(logs.flatMap((log) => log.answer?.citations ?? []));
  const deps = ctx.repositoryDeps();
  // Prefer an explicit override; otherwise inherit the flow the matched gaps came
  // from. Candidates within a cluster share a flow (clustering is per-flow), so
  // this routes the draft to that flow's destination + sources even on the
  // autonomous gap-to-PR path, which passes no override.
  const flow = selectFlow(deps, overrides.flowId ?? derivedFlowId(matched));
  const sourceIds = overrides.sourceIds ?? flow?.sourceIds;
  const destinationId = overrides.destinationId?.trim() || flow?.destinationId || defaultDestinationId(deps);
  console.log(
    `Drafting proposal for ${label} (flow=${flow?.id ?? "none"}, destination=${destinationId ?? "none"}, ` +
      `provider=${ctx.config.get().aiProvider})`
  );
  const sourceContext = await collectSourceContextCached(deps, sourceIds, overrides.sourceContextCache);
  const materialFiles = sourceContext.filter((context) => context.path && context.content !== "Source path does not exist.");
  if (materialFiles.length === 0) {
    console.warn(
      `Drafting proposal for ${label} with no real source files attached — ` +
        "the model will likely produce a placeholder. Check the source configuration and subpaths."
    );
  } else {
    console.log(`Proposal draft will use ${materialFiles.length} source file(s) as raw material.`);
  }
  // Drafting is enqueue-only: the watcher runs the generative work and the
  // proposal lands later via createProposalFromCompletedJob. The configured
  // provider is passed through as-is (the @magpie/jobs contract validates it).
  const input: DraftMarkdownProposalJobInput & { provider: AiProviderName } = {
    gapSummaries,
    triggeringQuestions: logs.map((log) => log.question),
    evidence,
    sourceContext,
    // Omit the key entirely when there's nothing in flight, so the serialised
    // prompt input carries no empty noise.
    openPullRequests: overrides.openPullRequests?.length ? overrides.openPullRequests : undefined,
    destinationId,
    targetPath: overrides.targetPath?.trim() || undefined,
    gapClusterId: overrides.gapClusterId,
    provider: ctx.config.get().aiProvider,
    expectedOutput: "markdown_proposal"
  };

  const job = await ctx.jobs.create("draft_markdown_proposal", {
    ...input,
    triggeringQuestionIds: questionIds
  });

  console.log(`Enqueued draft_markdown_proposal job ${job.id} for ${label}`);
  return { ok: true as const, job };
}

// Wraps collectSourceContext with the optional per-run memo. The key is the
// resolved source-id set (sorted, so order can't fragment it); an undefined set
// means "the configured default sources", which collectSourceContext resolves
// deterministically, so it caches safely under a stable sentinel key.
async function collectSourceContextCached(
  deps: ReturnType<AppContext["repositoryDeps"]>,
  sourceIds: string[] | undefined,
  cache: SourceContextCache | undefined
): Promise<SourceDataContext[]> {
  if (!cache) {
    return collectSourceContext(deps, sourceIds);
  }
  const key = sourceIds ? [...sourceIds].sort().join("\0") : "\0default";
  const cached = cache.get(key);
  if (cached) {
    console.log(`Reusing cached source context for [${sourceIds?.join(", ") ?? "default"}] (${cached.length} entr${cached.length === 1 ? "y" : "ies"}).`);
    return cached;
  }
  const collected = await collectSourceContext(deps, sourceIds);
  cache.set(key, collected);
  return collected;
}

// The flow a set of matched gap candidates agree on, or undefined when they span
// several flows or none carry one. Used to default a draft's destination/sources
// to the flow that surfaced the gaps when the caller gives no explicit override.
function derivedFlowId(candidates: GapCandidate[]): string | undefined {
  const flowIds = new Set(candidates.map((candidate) => candidate.flowId).filter(Boolean));
  return flowIds.size === 1 ? [...flowIds][0] : undefined;
}

// Stored on the proposal as a human-readable record of which gaps it closes.
function joinGapSummaries(summaries: string[]): string {
  return summaries.join("\n");
}

// Inverse of joinGapSummaries: recovers the individual gap summaries a proposal
// closes from its stored newline-joined record.
export function splitGapSummaries(gapSummary: string | undefined): string[] {
  return (gapSummary ?? "")
    .split("\n")
    .map((summary) => summary.trim())
    .filter((summary) => summary.length > 0);
}

function dedupeCitations(citations: Proposal["evidence"]): Proposal["evidence"] {
  const seen = new Set<string>();
  const result: Proposal["evidence"] = [];
  for (const citation of citations) {
    const key = citation.sectionId || `${citation.path}#${citation.anchor}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(citation);
  }
  return result;
}

export async function createProposalFromCompletedJob(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<Proposal | undefined> {
  if (!job || job.type !== "draft_markdown_proposal" || !isDraftMarkdownProposalJobOutput(output)) {
    return undefined;
  }

  const input = job.input as Partial<DraftMarkdownProposalJobInput> & {
    triggeringQuestionIds?: string[];
  };

  return ctx.stores.proposals.create({
    ...output,
    targetPath: resolveProposalTargetPath(destinationSubpath(ctx.repositoryDeps(), input.destinationId), output.title),
    evidence: input.evidence ?? [],
    gapSummary: input.gapSummaries ? joinGapSummaries(input.gapSummaries) : undefined,
    triggeringQuestionIds: input.triggeringQuestionIds,
    destinationId: input.destinationId,
    gapClusterId: input.gapClusterId,
    jobId: job.id,
    draftContext: buildDraftContext({
      gapSummaries: input.gapSummaries ?? [],
      sourceContext: input.sourceContext,
      evidence: input.evidence ?? [],
      openPullRequests: input.openPullRequests
    })
  });
}

// Completion handler for correct_document jobs: a verify-lens repair landed, so
// create a draft Proposal for it. flowId is carried first-class so the gate and the
// per-flow outbox treat it as same-flow; the title is prefixed for PR-stream triage.
// The store de-dupes by jobId, so a re-delivered completion returns the same proposal
// rather than drafting a duplicate.
export async function createCorrectiveProposalFromCompletedJob(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<Proposal | undefined> {
  if (!job || job.type !== "correct_document") {
    return undefined;
  }
  const parsed = correctDocumentOutputSchema.safeParse(output);
  if (!parsed.success) {
    return undefined;
  }
  const input = job.input as Partial<CorrectDocumentJobInput>;
  if (!input.path) {
    return undefined;
  }
  return ctx.stores.proposals.create({
    title: `Verify: correct unprovable claims in ${input.path}`,
    targetPath: input.path,
    markdown: parsed.data.markdown,
    rationale: parsed.data.rationale,
    evidence: [],
    flowId: input.flowId,
    destinationId: input.destinationId,
    jobId: job.id
  });
}

// Completion handler for dedupe_documents jobs: a dedupe-lens scan landed. When it
// found a real duplicate, create a draft Proposal carrying the pairwise changeset and
// its flowId (so the gate and per-flow outbox treat it as same-flow). The primary doc
// (survivor) supplies targetPath + markdown for display/branch/PR. Silent when the scan
// found no duplicate or returned a malformed changeset. Idempotent on jobId.
export async function createDedupeProposalFromCompletedJob(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<Proposal | undefined> {
  if (!job || job.type !== "dedupe_documents") {
    return undefined;
  }
  const parsed = dedupeDocumentsOutputSchema.safeParse(output);
  if (!parsed.success) {
    return undefined;
  }
  const { duplicate, changeset, primaryPath, rationale } = parsed.data;
  if (!duplicate || !changeset || !primaryPath) {
    return undefined;
  }
  // The survivor must have a concrete body to publish and display; a changeset that
  // names a primary it does not actually write is malformed — skip it.
  const primaryWrite = changeset.find((change) => change.path === primaryPath);
  if (!primaryWrite || primaryWrite.content === undefined) {
    return undefined;
  }
  const otherPath = changeset.find((change) => change.path !== primaryPath)?.path ?? "a neighbour";
  const input = job.input as Partial<DedupeDocumentsJobInput>;
  return ctx.stores.proposals.create({
    title: `Dedupe: reconcile ${primaryPath} with ${otherPath}`,
    targetPath: primaryPath,
    markdown: primaryWrite.content,
    changeset,
    rationale,
    evidence: [],
    flowId: input.flowId,
    destinationId: input.destinationId,
    jobId: job.id
  });
}

// Completion handler for publish_proposal jobs: records the validated git
// publication the watcher performed (branch, commit, optional remote/PR url) onto
// the linked proposal. Idempotent by proposalId — a proposal that already carries
// a publication is left untouched, so re-completing the same job never
// double-applies or regresses the recorded metadata.
export async function recordPublicationFromCompletedJob(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<Proposal | undefined> {
  if (!job || job.type !== "publish_proposal" || !isPublishProposalJobOutput(output)) {
    return undefined;
  }

  const existing = await ctx.stores.proposals.get(output.proposalId);
  if (!existing) {
    return undefined;
  }
  if (existing.publication) {
    return existing;
  }

  return ctx.stores.proposals.recordPublication(output.proposalId, {
    provider: "local-git",
    branchName: output.branchName,
    commitSha: output.commitSha,
    remoteUrl: output.remoteUrl,
    pullRequestUrl: output.pullRequestUrl,
    publishedAt: output.publishedAt
  });
}

export function isProposalStatus(value: unknown): value is Proposal["status"] {
  return (
    value === "draft" ||
    value === "ready" ||
    value === "branch-pushed" ||
    value === "pr-opened" ||
    value === "merged" ||
    value === "rejected"
  );
}

function isPublishProposalJobOutput(value: unknown): value is PublishProposalJobOutput {
  return publishProposalOutputSchema.safeParse(value).success;
}

function isDraftMarkdownProposalJobOutput(value: unknown): value is DraftMarkdownProposalJobOutput {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<DraftMarkdownProposalJobOutput>;
  return (
    typeof candidate.title === "string" &&
    typeof candidate.targetPath === "string" &&
    typeof candidate.markdown === "string" &&
    typeof candidate.rationale === "string"
  );
}
