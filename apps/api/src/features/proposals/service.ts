import type {
  DraftMarkdownProposalJobInput,
  DraftMarkdownProposalJobOutput,
  GapCandidate,
  Proposal
} from "@magpie/core";
import type { JobView } from "@magpie/jobs";
import { isAiProviderName } from "@magpie/jobs";
import { resolveProposalTargetPath } from "@magpie/core";
import { DRAFT_MARKDOWN_PROPOSAL } from "@magpie/prompts";
import { LocalGitProposalPublisher, raisePullRequest } from "@magpie/git";
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
import { parseJsonObject } from "../../platform/json.js";
import { slugify } from "../../platform/paths.js";
import { type AiProviderName } from "../../platform/providers.js";

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
export async function resolveGapsForMergedProposal(ctx: AppContext, proposal: Proposal): Promise<number> {
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
export async function reindexDestinationForProposal(ctx: AppContext, proposal: Proposal): Promise<boolean> {
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

// Pushes a "ready" proposal's branch and raises a PR for it, degrading to a
// branch-only publish if the PR can't be opened. Shared by the HTTP publish
// route and the scheduled gap-to-PR task, so the result is a discriminated
// outcome rather than an HTTP response — callers map it to their own surface.
export async function publishReadyProposal(ctx: AppContext, proposal: Proposal) {
  const repository = await findRepositoryForProposal(ctx.repositoryDeps(), proposal);
  if (!repository) {
    return {
      ok: false as const,
      code: "proposal_repository_not_found",
      message: "No indexed Git repository matches this proposal target path."
    };
  }

  if (repository.git?.scope === "not-git" || !repository.git?.workTreeRoot) {
    return {
      ok: false as const,
      code: "proposal_repository_not_git",
      message: "The matched repository is not a Git checkout."
    };
  }

  try {
    const publisher = new LocalGitProposalPublisher();
    const publication = await publisher.publish({
      repository,
      branchName: createProposalBranchName(proposal),
      title: `docs: ${proposal.title}`,
      markdown: proposal.markdown,
      targetPath: proposal.targetPath
    });
    // The branch is now on the remote; try to open a PR for it. A PR failure
    // (unsupported host, bad token, API error) must not lose the pushed branch,
    // so we degrade to a branch-only publish and surface the reason.
    let pullRequestUrl: string | undefined;
    let pullRequestWarning: string | undefined;
    try {
      const baseBranch = repository.defaultBranch || repository.git?.defaultBranch || "main";
      const raised = await raisePullRequest({
        remoteUrl: publication.remoteUrl,
        headBranch: publication.branchName,
        baseBranch,
        title: `docs: ${proposal.title}`,
        body: buildPullRequestBody(proposal)
      });
      pullRequestUrl = raised?.url;
      console.log(
        raised
          ? `Raised pull request ${raised.url} for proposal ${proposal.id}`
          : `Pushed branch ${publication.branchName}; no PR raised (unsupported host or missing token).`
      );
    } catch (error) {
      pullRequestWarning = error instanceof Error ? error.message : "Pull request creation failed";
      console.warn(`Branch ${publication.branchName} pushed, but PR creation failed: ${pullRequestWarning}`);
    }

    const updatedProposal = await ctx.stores.proposals.recordPublication(proposal.id, {
      provider: "local-git",
      branchName: publication.branchName,
      commitSha: publication.commitSha,
      remoteUrl: publication.remoteUrl,
      pullRequestUrl,
      publishedAt: new Date().toISOString()
    });

    return { ok: true as const, proposal: updatedProposal, publication, pullRequestUrl, pullRequestWarning };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Proposal publish failed";
    return { ok: false as const, code: "proposal_publish_failed", message };
  }
}

// Human-facing PR description linking the merge back to the gaps it closes.
export function buildPullRequestBody(proposal: Proposal): string {
  const lines = ["Proposed by Markdown Magpie to close knowledge gaps.", ""];
  if (proposal.rationale) {
    lines.push(proposal.rationale, "");
  }
  const summaries = splitGapSummaries(proposal.gapSummary);
  if (summaries.length > 0) {
    lines.push("Gaps addressed:");
    lines.push(...summaries.map((summary) => `- ${summary}`));
  }
  return lines.join("\n").trim();
}

// Drafts ONE proposal from one or more gap candidates. The reviewer (via the
// clustering UI) decides which gaps belong together, so this accepts either a
// single `summary` (legacy /from-gap) or a `summaries` array (a confirmed
// cluster from /from-gaps). Evidence and triggering questions are unioned across
// every gap in the cluster so the drafter sees the full picture once.
// Core of "draft one proposal from a confirmed cluster of gap summaries",
// independent of HTTP so the scheduled gap-to-PR task can reuse it. Returns a
// discriminated outcome: in direct mode the proposal is already created; in
// queue mode an AI job is enqueued and the proposal lands later via the job
// completion machinery.
export async function draftFromGaps(
  ctx: AppContext,
  rawSummaries: string[],
  overrides: { targetPath?: string; flowId?: string; sourceIds?: string[]; destinationId?: string } = {}
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
  const flow = selectFlow(deps, overrides.flowId);
  const sourceIds = overrides.sourceIds ?? flow?.sourceIds;
  const destinationId = overrides.destinationId?.trim() || flow?.destinationId || defaultDestinationId(deps);
  console.log(
    `Drafting proposal for ${label} (flow=${flow?.id ?? "none"}, destination=${destinationId ?? "none"}, ` +
      `provider=${ctx.config.get().aiProvider}, mode=${ctx.config.get().aiExecutionMode})`
  );
  const sourceContext = await collectSourceContext(deps, sourceIds);
  const materialFiles = sourceContext.filter((context) => context.path && context.content !== "Source path does not exist.");
  if (materialFiles.length === 0) {
    console.warn(
      `Drafting proposal for ${label} with no real source files attached — ` +
        "the model will likely produce a placeholder. Check the source configuration and subpaths."
    );
  } else {
    console.log(`Proposal draft will use ${materialFiles.length} source file(s) as raw material.`);
  }
  // The @magpie/jobs schema requires a concrete AI provider (not "mock").
  const configuredProvider = ctx.config.get().aiProvider;
  const jobProvider = isAiProviderName(configuredProvider) ? configuredProvider : "openai-compatible";
  const input: DraftMarkdownProposalJobInput & { provider: AiProviderName } = {
    gapSummaries,
    triggeringQuestions: logs.map((log) => log.question),
    evidence,
    sourceContext,
    destinationId,
    targetPath: overrides.targetPath?.trim() || undefined,
    provider: jobProvider,
    expectedOutput: "markdown_proposal"
  };

  if (ctx.config.get().aiExecutionMode === "direct") {
    const output = await draftMarkdownProposalDirect(ctx, input);
    const proposal = await ctx.stores.proposals.create({
      ...output,
      targetPath: resolveProposalTargetPath(destinationSubpath(deps, input.destinationId), output.title),
      evidence,
      gapSummary: joinGapSummaries(gapSummaries),
      triggeringQuestionIds: questionIds,
      destinationId: input.destinationId
    });

    console.log(`Created proposal ${proposal.id} directly for ${label} (target ${proposal.targetPath})`);
    return { ok: true as const, mode: "direct" as const, proposal };
  }

  const job = await ctx.jobs.create("draft_markdown_proposal", {
    ...input,
    triggeringQuestionIds: questionIds
  });

  console.log(`Enqueued draft_markdown_proposal job ${job.id} for ${label}`);
  return { ok: true as const, mode: "queue" as const, job };
}

export async function draftMarkdownProposalDirect(
  ctx: AppContext,
  input: DraftMarkdownProposalJobInput
): Promise<DraftMarkdownProposalJobOutput> {
  if (ctx.config.get().aiProvider === "mock") {
    return createMockMarkdownProposal(ctx, input);
  }

  const response = await ctx.providers.chat(ctx.config.get().aiProvider).complete({
    system: DRAFT_MARKDOWN_PROPOSAL.instructions,
    messages: [
      {
        role: "user",
        content: JSON.stringify(input, null, 2)
      }
    ]
  });
  const output = parseJsonObject(response.content);

  if (!isDraftMarkdownProposalJobOutput(output)) {
    throw new Error("Direct proposal provider returned invalid markdown proposal output");
  }

  return output;
}

export function createMockMarkdownProposal(
  ctx: AppContext,
  input: DraftMarkdownProposalJobInput
): DraftMarkdownProposalJobOutput {
  const title = titleFromGapSummary(input.gapSummaries[0] ?? "");
  const targetPath = resolveProposalTargetPath(destinationSubpath(ctx.repositoryDeps(), input.destinationId), title);
  const gapList = input.gapSummaries.length
    ? input.gapSummaries.map((summary) => `- ${summary}`).join("\n")
    : "- No gap summaries recorded.";
  const gapHeading = input.gapSummaries.length === 1 ? "Gap" : "Gaps";
  const triggeringQuestions = input.triggeringQuestions.length
    ? input.triggeringQuestions.map((question) => `- ${question}`).join("\n")
    : "- No triggering questions recorded.";
  const evidence = input.evidence.length
    ? input.evidence.map((citation) => `- ${citation.path}#${citation.anchor}: ${citation.heading}`).join("\n")
    : "- No supporting citations were available.";
  const sourceMaterial = input.sourceContext?.length
    ? input.sourceContext
        .slice(0, 8)
        .map((source) => `- ${source.sourceName}${source.path ? ` (${source.path})` : source.url ? ` (${source.url})` : ""}`)
        .join("\n")
    : "- No raw source context was attached.";

  return {
    title,
    targetPath,
    markdown: `---\ntitle: ${JSON.stringify(title)}\nstatus: draft\n---\n\n# ${title}\n\n## ${gapHeading}\n\n${gapList}\n\n## Triggering Questions\n\n${triggeringQuestions}\n\n## Proposed Guidance\n\nAdd reviewed guidance that directly answers ${input.gapSummaries.length === 1 ? "this gap" : "these related gaps"}. Keep the final content specific, source-backed, and easy for maintainers to verify.\n\n## Raw Source Material\n\n${sourceMaterial}\n\n## Evidence\n\n${evidence}\n`,
    rationale: "Generated from the selected gap candidate(s) using the deterministic mock provider."
  };
}

export function titleFromGapSummary(summary: string): string {
  const normalized = summary
    .replace(/^no (?:sufficient )?source material found for:\s*/i, "")
    .replace(/[?.!]+$/g, "")
    .trim();
  if (!normalized) {
    return "Knowledge Gap Proposal";
  }

  return normalized
    .split(/\s+/)
    .slice(0, 10)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

// Stored on the proposal as a human-readable record of which gaps it closes.
export function joinGapSummaries(summaries: string[]): string {
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

export function dedupeCitations(citations: Proposal["evidence"]): Proposal["evidence"] {
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

export function createProposalBranchName(proposal: Proposal): string {
  return `magpie/proposal-${proposal.id.slice(0, 8)}-${slugify(proposal.title).slice(0, 40)}`;
}

export async function createProposalFromCompletedJob(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<void> {
  if (!job || job.type !== "draft_markdown_proposal" || !isDraftMarkdownProposalJobOutput(output)) {
    return;
  }

  const input = job.input as Partial<DraftMarkdownProposalJobInput> & {
    triggeringQuestionIds?: string[];
  };

  await ctx.stores.proposals.create({
    ...output,
    targetPath: resolveProposalTargetPath(destinationSubpath(ctx.repositoryDeps(), input.destinationId), output.title),
    evidence: input.evidence ?? [],
    gapSummary: input.gapSummaries ? joinGapSummaries(input.gapSummaries) : undefined,
    triggeringQuestionIds: input.triggeringQuestionIds,
    destinationId: input.destinationId,
    jobId: job.id
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

export function isDraftMarkdownProposalJobOutput(value: unknown): value is DraftMarkdownProposalJobOutput {
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
