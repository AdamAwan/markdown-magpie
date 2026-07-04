import type {
  AnswerQuestionJobInput,
  CorrectDocumentJobInput,
  DedupeDocumentsJobInput,
  ImproveDocumentJobInput,
  DraftContext,
  DraftMarkdownProposalJobInput,
  DraftMarkdownProposalJobOutput,
  DraftSeedDocumentJobInput,
  GapCandidate,
  OpenPullRequestContext,
  Proposal,
  QuestionLog,
  RepositoryRef,
  SourceDataContext,
  SplitDocumentJobInput
} from "@magpie/core";
import type { JobState, JobView, verifyGapClosureOutputSchema } from "@magpie/jobs";
import { runJobToCompletion } from "../jobs/service.js";
import { citesMergedDoc, evaluateClosure, proposalTargetPaths } from "./closure-eval.js";
import { fileURLToPath } from "node:url";
import { mergeLocalProposalBranch } from "@magpie/git";
import { z } from "zod";
import { correctDocumentOutputSchema, dedupeDocumentsOutputSchema, draftSeedDocumentOutputSchema, improveDocumentOutputSchema, publishProposalOutputSchema, splitDocumentOutputSchema } from "@magpie/jobs";
import { PROPOSAL_STATUSES, resolveProposalTargetPath } from "@magpie/core";
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
import { collectSourceContextCached, type SourceContextCache } from "../../platform/source-context.js";
import { type AiProviderName } from "../../platform/providers.js";
import { logger } from "../../logger.js";

type PublishProposalJobOutput = z.infer<typeof publishProposalOutputSchema>;

export async function list(ctx: AppContext, limit: number, options?: ProposalListOptions): Promise<Proposal[]> {
  const proposals = await ctx.stores.proposals.list(limit, options);
  return proposals.map((proposal) => ({ ...proposal, localGitDestination: isLocalGitDestination(ctx, proposal) }));
}

export async function get(ctx: AppContext, id: string): Promise<Proposal | undefined> {
  const proposal = await ctx.stores.proposals.get(id);
  return proposal ? { ...proposal, localGitDestination: isLocalGitDestination(ctx, proposal) } : undefined;
}

export async function updateStatus(
  ctx: AppContext,
  id: string,
  status: Proposal["status"]
): Promise<Proposal | undefined> {
  return ctx.stores.proposals.updateStatus(id, status);
}

// The number of failed closure verifications a triggering question tolerates
// before its gap is flagged for a human instead of auto-redrafting.
const CLOSURE_RETRY_CAP = 2;

type VerifyGapClosureOutput = z.infer<typeof verifyGapClosureOutputSchema>;

// Non-terminal job states that mean a verify_gap_closure job hasn't finished
// executing yet — mirrors IN_FLIGHT_JOB_STATES in features/scheduled-tasks/
// service.ts.
const VERIFY_GAP_CLOSURE_IN_FLIGHT_STATES: ReadonlySet<JobState> = new Set<JobState>([
  "created",
  "active",
  "retry",
  "blocked"
]);

// The proposalId a verify_gap_closure job's input carries (its whole input
// shape is `{ proposalId }` — see verifyGapClosureInputSchema).
function jobProposalId(input: unknown): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const candidate = (input as { proposalId?: unknown }).proposalId;
  return typeof candidate === "string" ? candidate : undefined;
}

// True when a verify_gap_closure job for this proposal is already queued or
// running. The JobBroker interface's create() takes no dedup option (pg-boss's
// own singletonKey only dedups under its non-"standard" queue policies, which
// this catalog does not opt this queue into), so overlap protection is a scan
// by type + matching proposalId, the same broker-agnostic pattern
// isTaskRunning uses in features/scheduled-tasks/service.ts. This is
// belt-and-braces against a race between two concurrent merge cascades; the
// primary defence is the transition guard in routes.ts (only a genuine
// draft/branch-pushed/pr-opened → merged transition schedules a cascade at
// all).
async function isVerifyGapClosureInFlight(ctx: AppContext, proposalId: string): Promise<boolean> {
  const { jobs } = await ctx.jobs.list({ type: "verify_gap_closure", limit: 200 });
  return jobs.some(
    (job) => VERIFY_GAP_CLOSURE_IN_FLIGHT_STATES.has(job.state) && jobProposalId(job.input) === proposalId
  );
}

// The work that must happen once a proposal is merged, shared by the manual
// "Mark merged" endpoint and the pull-request poller: re-index the destination
// knowledge base, then verify (rather than assume) that the merge closed its
// gaps. Gap resolution is no longer blind — it is gated on re-asking the
// triggering questions (see verifyGapClosure), enqueued here as a job so the
// re-asks run through the normal queue-only answer path.
//
// Enqueueing verification is idempotent per proposal: a proposal whose closure
// was already verified (closureStatus set) or whose verification is already
// queued/running is not re-enqueued, so a merge cascade that somehow runs
// twice for the same proposal (a race between callers, rather than the
// ordinary retried-POST case routes.ts already guards against) cannot
// double-enqueue the job and double-count a still-open verdict against
// CLOSURE_RETRY_CAP.
export async function runMergeCascade(
  ctx: AppContext,
  proposal: Proposal
): Promise<{ reindexed: boolean; verificationEnqueued: boolean }> {
  const reindexed = await reindexDestinationForProposal(ctx, proposal);
  // Seed / clusterless proposals have no triggering questions to re-ask, so there
  // is nothing to verify (and nothing was ever resolved for them).
  const hasTriggers = (proposal.triggeringQuestionIds ?? []).length > 0;
  if (!hasTriggers || proposal.closureStatus || (await isVerifyGapClosureInFlight(ctx, proposal.id))) {
    return { reindexed, verificationEnqueued: false };
  }
  await ctx.jobs.create("verify_gap_closure", { proposalId: proposal.id });
  logger.info({ proposalId: proposal.id }, "enqueued gap-closure verification for merged proposal");
  return { reindexed, verificationEnqueued: true };
}

// Re-asks each triggering question of a merged proposal and checks whether the
// merged document now answers it (deterministically: a confident answer that
// cites one of the proposal's target docs). All triggering questions must close
// for the gap to resolve; any still-open question reopens the gap (carrying the
// verification detail) so it re-drafts — until the retry cap, past which it is
// flagged for a human. The re-asks go through runJobToCompletion, so the only
// generative step is an enqueued answer_question job a provider watcher claims.
export async function verifyGapClosure(ctx: AppContext, proposal: Proposal): Promise<VerifyGapClosureOutput> {
  // Entry guard: a proposal already carries a closureStatus once one run has
  // recorded a verdict for it. Re-running would re-ask every triggering
  // question (duplicate LLM spend) and, worse, record a second "still_open" row
  // per question into the unscoped counter countPriorStillOpen sums for
  // CLOSURE_RETRY_CAP — so a single transient failure would count twice toward
  // the cap. This is the last line of defence: even if two verify_gap_closure
  // jobs land for the same proposal (racing enqueues, a duplicate /verify-closure
  // callback, etc.), only the first to reach here does the work.
  if (proposal.closureStatus) {
    logger.info(
      { proposalId: proposal.id, closureStatus: proposal.closureStatus },
      "gap-closure verification already recorded for this proposal; skipping re-verification"
    );
    return { proposalId: proposal.id, closureStatus: proposal.closureStatus, perQuestion: [] };
  }

  const questionIds = proposal.triggeringQuestionIds ?? [];
  // Compare in ONE path space: citations carry indexed-subtree-relative paths
  // (subpath stripped), so strip the destination's subpath off the proposal's
  // target paths too. Resolve the destination with the same helper the publisher
  // uses, so both handle an explicit destinationId and the inferred single/subpath
  // match identically.
  const subpath = selectDestinationForProposal(ctx.repositoryDeps(), proposal)?.subpath;
  const targetPaths = proposalTargetPaths(proposal, subpath);
  const provider = ctx.config.get().aiProvider;
  const flows = ctx.knowledgeConfig.flows.map((flow) => ({
    id: flow.id,
    name: flow.name,
    ...(flow.persona ? { persona: flow.persona } : {})
  }));

  const perQuestion: VerifyGapClosureOutput["perQuestion"] = [];
  let anyStillOpen = false;
  let needsAttention = false;

  for (const questionId of questionIds) {
    const original = await ctx.stores.questionLogs.get(questionId);
    if (!original) {
      // The triggering question is gone; we cannot re-ask it, so we cannot claim
      // closure. Record it as still-open (no re-ask) and move on.
      await ctx.stores.gapClosureVerifications.record({
        proposalId: proposal.id,
        gapClusterId: proposal.gapClusterId,
        questionId,
        verdict: "still_open",
        confidence: "unknown",
        citedMergedDoc: false,
        detail: "triggering question log not found; could not re-ask"
      });
      perQuestion.push({ questionId, reaskedQuestionId: null, verdict: "still_open" });
      anyStillOpen = true;
      continue;
    }

    // A fresh question log for the re-ask; answer_question completion fills in its
    // answer, confidence and citations against the now-updated index.
    const reasked = await ctx.stores.questionLogs.record({
      question: original.question,
      chatProvider: provider,
      retrievedSectionIds: []
    });
    const requestedFlowId = resolveVerificationFlowId(ctx, proposal, original);
    const input: AnswerQuestionJobInput & { provider: typeof provider } = {
      questionLogId: reasked.id,
      question: original.question,
      flows,
      ...(requestedFlowId ? { requestedFlowId } : {}),
      provider,
      expectedOutput: "answer_result"
    };

    try {
      await runJobToCompletion(ctx, "answer_question", input);
    } catch (error) {
      // A timeout / no provider watcher means we could not verify — treat as
      // still-open below rather than claiming a closure we did not observe.
      const message = error instanceof Error ? error.message : "unknown error";
      logger.warn({ proposalId: proposal.id, questionId, err: message }, "gap-closure re-ask did not complete");
    }

    const answered = await ctx.stores.questionLogs.get(reasked.id);
    const answer = answered?.answer
      ? { confidence: answered.answer.confidence, citations: answered.answer.citations }
      : undefined;
    const verdict = evaluateClosure(answer, targetPaths);
    const cited = answer ? citesMergedDoc(answer.citations, targetPaths) : false;
    const detail = buildVerificationDetail(answer, targetPaths);

    await ctx.stores.gapClosureVerifications.record({
      proposalId: proposal.id,
      gapClusterId: proposal.gapClusterId,
      questionId,
      reaskedQuestionId: reasked.id,
      verdict,
      confidence: answer?.confidence ?? "unknown",
      citedMergedDoc: cited,
      detail
    });
    perQuestion.push({ questionId, reaskedQuestionId: reasked.id, verdict });

    if (verdict === "closed") {
      // This question's re-ask confirmed closure: resolve its matching gaps
      // immediately, regardless of siblings' outcomes. This allows per-question
      // resolution even if a sibling is still_open.
      await resolveGapsForClosedQuestion(ctx, questionId, proposal);
    } else if (verdict === "still_open") {
      anyStillOpen = true;
      // countPriorStillOpen includes the row just recorded, so the Nth *distinct
      // proposal* to fail reads as N. Bound it to since the question's prior
      // verification-lineage gap (if any) was resolved/dismissed, so a question
      // fixed or dismissed by a human starts a fresh retry budget instead of
      // carrying an old, permanently-burned count forward (see
      // countPriorStillOpen's doc comment for the full rationale).
      const sinceReset = verificationLineageResetSince(original);
      const failures = await ctx.stores.gapClosureVerifications.countPriorStillOpen(questionId, sinceReset);
      const capped = failures >= CLOSURE_RETRY_CAP;
      if (capped) {
        needsAttention = true;
      }
      const summary = await reopenSummaryFor(ctx, original, proposal, questionId);
      await ctx.stores.questionLogs.recordVerificationGap(questionId, {
        summary,
        source: capped ? "needs_attention" : "verification",
        note: detail
      });
    }
  }

  const closureStatus: VerifyGapClosureOutput["closureStatus"] = anyStillOpen
    ? needsAttention
      ? "needs_attention"
      : "reopened"
    : "verified_closed";

  if (closureStatus === "verified_closed") {
    // Verified: now (and only now) resolve the gaps the proposal set out to close.
    await resolveGapsForMergedProposal(ctx, proposal);
  }

  await ctx.stores.proposals.setClosureStatus(proposal.id, closureStatus);
  logger.info(
    { proposalId: proposal.id, closureStatus, questions: perQuestion.length },
    "gap-closure verification complete"
  );
  return { proposalId: proposal.id, closureStatus, perQuestion };
}

// Resolves the flow to pin the gap-closure re-ask to. The candidate (the
// proposal's recorded flowId, falling back to the original question's) may
// name a flow that has since been deleted or renamed from the (user-editable)
// knowledge config — unlike the ask path, which rejects an unknown flow with a
// 400 before ever enqueueing (see resolveRequestedFlow in features/ask/service.ts),
// there is no caller here to reject, so a stale id is silently dropped instead.
// Pinning retrieval to a flow that no longer exists would otherwise make
// resolveRepositoryScope fail the re-ask with unknown_flow, which reads as a
// false still_open verdict and can wrongly park a gap needs_attention even
// though the merged doc fully answers it. Dropping the id falls back to
// auto-routing across the currently configured flows instead.
function resolveVerificationFlowId(
  ctx: AppContext,
  proposal: Proposal,
  original: QuestionLog
): string | undefined {
  const candidate = proposal.flowId ?? original.flowId;
  if (!candidate) {
    return undefined;
  }
  if (!ctx.knowledgeConfig.flows.some((flow) => flow.id === candidate)) {
    logger.warn(
      { proposalId: proposal.id, flowId: candidate },
      "dropping stale requestedFlowId for gap-closure re-ask; falling back to auto-routing"
    );
    return undefined;
  }
  return candidate;
}

// The gap summary a reopened verification gap is filed under, for the specific
// triggering question that failed. It must be the summary of the gap the proposal
// actually addressed FOR THIS QUESTION — not merely the question's oldest open gap
// (which may be an unrelated older gap that loads first) nor element [0] of the
// proposal's newline-joined display blob (which belongs to whichever gap sorted
// first, not necessarily this question's). Filing it correctly is what lets the
// reopened gap dedup with its existing row and be resolved by a later same-scope
// proposal, and keeps an unrelated draft from inheriting this failure note.
//
// Primary: the proposal's persisted cluster carries the structured
// question→summary association (membership rows → each gap's (questionId,
// summary)), so resolve THIS question's summary from there. Fallback (no cluster,
// or the cluster no longer holds a gap for this question): intersect this
// question's own open-gap summaries with the proposal's recorded summaries, so we
// pick the open gap the proposal set out to close rather than the oldest. Final
// fallback: the question text.
async function reopenSummaryFor(
  ctx: AppContext,
  original: { question: string; gaps?: Array<{ summary: string; source: string; resolvedAt?: string; dismissedAt?: string }> },
  proposal: Proposal,
  questionId: string
): Promise<string> {
  if (proposal.gapClusterId) {
    const memberships = await ctx.stores.gapClusters.listMembershipsForCluster(proposal.gapClusterId);
    const pairs = await ctx.stores.questionLogs.gapPairsForIds(memberships.map((membership) => membership.gapId));
    const clusterGap = pairs.find((pair) => pair.questionId === questionId);
    if (clusterGap) {
      return clusterGap.summary;
    }
  }

  const proposalSummaries = new Set(splitGapSummaries(proposal.gapSummary));
  const addressedGap = (original.gaps ?? []).find(
    (gap) =>
      !gap.resolvedAt &&
      !gap.dismissedAt &&
      gap.source !== "needs_attention" &&
      proposalSummaries.has(gap.summary)
  );
  return addressedGap?.summary ?? original.question;
}

// The retry-cap reset boundary for this question, if any: recordVerificationGap
// keeps at most one LIVE 'verification'/'needs_attention' gap row per question,
// updating it in place on every reopen — but resolved/dismissed rows are
// retained (never deleted), so a question can carry several such rows over its
// lifetime, one per past lineage. The most recent one (gaps are ordered
// chronologically, so the last match) reflects this question's current state:
// if it is still live, this is an ongoing streak (no reset — full history still
// counts); if it is resolved or dismissed, that is exactly the prior
// closure-retry lineage having ended (a later proposal verified closure, or a
// human dismissed it) before a new gap arose on the same question, and its
// timestamp bounds countPriorStillOpen so that old lineage's failures don't
// count against this new one. Returns undefined when there is no such row
// (first-ever failure) or the most recent one is still open.
function verificationLineageResetSince(original: {
  gaps?: Array<{ source: string; resolvedAt?: string; dismissedAt?: string }>;
}): string | undefined {
  const lineageGap = [...(original.gaps ?? [])]
    .reverse()
    .find((gap) => gap.source === "verification" || gap.source === "needs_attention");
  const resetTimestamps = [lineageGap?.resolvedAt, lineageGap?.dismissedAt].filter(
    (value): value is string => Boolean(value)
  );
  return resetTimestamps.length > 0 ? resetTimestamps.sort().at(-1) : undefined;
}

// A compact, human-readable note for a failed closure: what merged and how the
// re-ask fell short. Stored on the reopened gap so a re-draft sees why.
function buildVerificationDetail(
  answer: { confidence: string; citations: Array<{ path: string }> } | undefined,
  targetPaths: Set<string>
): string {
  // targetPaths is already in citation (indexed-subtree) space, so the
  // citedMerged check below compares like-for-like. proposalTargetPaths always
  // includes the (required, truthy) targetPath, so this set is non-empty.
  const paths = [...targetPaths];
  const merged = paths.join(", ");
  if (!answer) {
    return `Merged ${merged}, but the re-asked question did not complete (no answer to verify).`;
  }
  const citedPaths = answer.citations.map((citation) => citation.path);
  const citedMerged = citedPaths.some((path) => paths.includes(path));
  return (
    `Merged ${merged}. Re-asking still returned confidence "${answer.confidence}"` +
    (citedMerged ? " and did cite the merged doc" : ` and did not cite the merged doc (cited: ${citedPaths.join(", ") || "nothing"})`) +
    "; the gap is not yet closed."
  );
}

// Resolves the gaps for a single question whose verdict is closed: precisely the
// rows whose question and summary match the proposal's recorded gap summaries, so
// unrelated gaps on a multi-topic question are left untouched. Returns the number
// of gaps newly resolved.
async function resolveGapsForClosedQuestion(
  ctx: AppContext,
  questionId: string,
  proposal: Proposal
): Promise<number> {
  const summaries = splitGapSummaries(proposal.gapSummary);
  if (summaries.length === 0) {
    return 0;
  }

  const resolved = await ctx.stores.questionLogs.resolveGaps([questionId], summaries, proposal.id);
  return resolved;
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
  logger.info({ proposalId: proposal.id, resolved }, "resolved gaps closed by merged proposal");
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
        logger.warn({ proposalId: proposal.id }, "no destination matched merged proposal; skipping re-index");
        return false;
      }

      // For a git destination this also fetches and fast-forwards the checkout,
      // bringing in the just-merged commit before we re-index.
      const localPath = await resolveConfiguredRepositoryLocalPath(destination, ctx.knowledgeConfig.checkoutRoot);
      await ctx.stores.knowledgeIndex.indexLocalRepository({
        localPath,
        repositoryId: destination.id,
        name: destination.name
      });
    } else {
      const repository = await findRepositoryForProposal(ctx.repositoryDeps(), proposal);
      if (!repository) {
        logger.warn({ proposalId: proposal.id }, "no repository matched merged proposal; skipping re-index");
        return false;
      }

      await ctx.stores.knowledgeIndex.indexLocalRepository({
        localPath: repository.localPath,
        repositoryId: repository.id,
        name: repository.name
      });
    }

    logger.info({ proposalId: proposal.id }, "re-indexed destination after merging proposal");
    void ctx.embedder.trigger();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    logger.warn({ proposalId: proposal.id, err: message }, "re-index after merging proposal failed");
    return false;
  }
}

function isFileUrl(url: string | undefined): url is string {
  if (!url) {
    return false;
  }
  try {
    return new URL(url).protocol === "file:";
  } catch {
    return false;
  }
}

// True when the proposal's configured destination is a local-git (file://)
// repository — the case where the console offers a real Merge instead of the
// hosted "Mark Merged". Config-only (no git/network), cheap enough per list item.
export function isLocalGitDestination(ctx: AppContext, proposal: Proposal): boolean {
  if (ctx.knowledgeConfig.destinations.length === 0) {
    return false;
  }
  const destination = selectDestinationForProposal(ctx.repositoryDeps(), proposal);
  return isFileUrl(destination?.url);
}

export type MergeLocalProposalResult =
  | { ok: true; proposal: Proposal }
  | {
      ok: false;
      code: "proposal_not_mergeable" | "not_local_git_destination" | "merge_conflict";
      message: string;
    };

// Merges a branch-pushed local-git proposal into its destination's default
// branch, then marks it merged. The git merge is injected so tests exercise the
// orchestration without shelling out. On merge failure the proposal is left at
// branch-pushed so git state and magpie state never disagree; the caller runs
// the (slow) re-index cascade after this returns ok.
export async function mergeLocalProposal(
  ctx: AppContext,
  proposal: Proposal,
  merge: typeof mergeLocalProposalBranch = mergeLocalProposalBranch
): Promise<MergeLocalProposalResult> {
  if (proposal.status !== "branch-pushed" || !proposal.publication?.branchName) {
    return {
      ok: false,
      code: "proposal_not_mergeable",
      message: "Only a branch-pushed proposal with a published branch can be merged locally."
    };
  }

  const destination = selectDestinationForProposal(ctx.repositoryDeps(), proposal);
  if (!destination || !isFileUrl(destination.url)) {
    return {
      ok: false,
      code: "not_local_git_destination",
      message: "This proposal's destination is not a local-git (file://) repository."
    };
  }

  const repoPath = fileURLToPath(destination.url);
  const defaultBranch = destination.branch?.trim() || "main";

  try {
    await merge({ repoPath, branchName: proposal.publication.branchName, defaultBranch });
  } catch (error) {
    return {
      ok: false,
      code: "merge_conflict",
      message: error instanceof Error ? error.message : "git merge failed"
    };
  }

  const merged = await ctx.stores.proposals.updateStatus(proposal.id, "merged");
  if (!merged) {
    return { ok: false, code: "proposal_not_mergeable", message: "Proposal not found." };
  }
  return { ok: true, proposal: merged };
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

  const job = await enqueuePublishProposal(ctx, proposal);
  return { ok: true, job };
}

// The single place the publish destination is decided: a file:// destination
// routes to the local-git publish queue (push only, no PR — a token-less watcher
// can serve it), anything else to github. Shared by the manual/scheduled publish
// path here and the source-sync fold in scheduling/fold.ts, so both route
// identically. isLocalGitDestination is config-only (no git/network).
export async function enqueuePublishProposal(ctx: AppContext, proposal: Proposal): Promise<JobView> {
  const destination = isLocalGitDestination(ctx, proposal) ? "local-git" : "github";
  const job = await ctx.jobs.create("publish_proposal", { proposalId: proposal.id, destination });
  logger.info({ jobId: job.id, proposalId: proposal.id, destination }, "enqueued publish_proposal job");
  return job;
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
// machinery (createProposalFromCompletedJob). Callers that draft in a loop pass one
// SourceContextCache (see platform/source-context) through so the sources are read once.

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
  // When this is a re-draft after a failed gap-closure verification, the reopened
  // gaps carry a `note` explaining why the last merge did not answer the question.
  // Surface those (for the gaps actually being drafted, still open) so the drafter
  // sees why it is being resubmitted and can address the specific shortfall.
  const gapSummarySet = new Set(gapSummaries);
  const resubmissionNotes = [
    ...new Set(
      logs.flatMap((log) =>
        (log.gaps ?? [])
          .filter(
            (gap) =>
              gap.note &&
              !gap.resolvedAt &&
              !gap.dismissedAt &&
              (gap.source === "verification" || gap.source === "needs_attention") &&
              gapSummarySet.has(gap.summary)
          )
          .map((gap) => gap.note as string)
      )
    )
  ];
  const deps = ctx.repositoryDeps();
  // Prefer an explicit override; otherwise inherit the flow the matched gaps came
  // from. Candidates within a cluster share a flow (clustering is per-flow), so
  // this routes the draft to that flow's destination + sources even on the
  // autonomous gap-to-PR path, which passes no override.
  const flow = selectFlow(deps, overrides.flowId ?? derivedFlowId(matched));
  const sourceIds = overrides.sourceIds ?? flow?.sourceIds;
  const destinationId = overrides.destinationId?.trim() || flow?.destinationId || defaultDestinationId(deps);
  logger.info({ label, flowId: flow?.id ?? "none", destinationId: destinationId ?? "none", provider: ctx.config.get().aiProvider }, "drafting proposal");
  const sourceContext = await collectSourceContextCached(deps, sourceIds, overrides.sourceContextCache);
  const materialFiles = sourceContext.filter((context) => context.path && context.content !== "Source path does not exist.");
  if (materialFiles.length === 0) {
    logger.warn({ label }, "drafting proposal with no real source files attached — model will likely produce a placeholder; check source configuration and subpaths");
  } else {
    logger.debug({ materialFileCount: materialFiles.length }, "proposal draft source files ready");
  }
  // Drafting is enqueue-only: the watcher runs the generative work and the
  // proposal lands later via createProposalFromCompletedJob. The configured
  // provider is passed through as-is (the @magpie/jobs contract validates it).
  const input: DraftMarkdownProposalJobInput & { provider: AiProviderName } = {
    gapSummaries,
    triggeringQuestions: logs.map((log) => log.question),
    evidence,
    // Omit entirely when this is not a resubmission, so a first-time draft's
    // prompt input carries no empty noise.
    resubmissionNotes: resubmissionNotes.length ? resubmissionNotes : undefined,
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

  logger.info({ jobId: job.id, label }, "enqueued draft_markdown_proposal job");
  return { ok: true as const, job };
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

// Completion handler for draft_seed_document jobs: a seed draft landed, so create a
// clusterless draft Proposal carrying flowId first-class (so the gate and the per-flow
// outbox treat it as same-flow). The model chooses the title/targetPath; the path is
// resolved under the destination subpath like a gap draft. De-duped by jobId, so a
// re-delivered completion returns the same proposal rather than drafting a duplicate.
export async function createSeedProposalFromCompletedJob(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<Proposal | undefined> {
  if (!job || job.type !== "draft_seed_document") {
    return undefined;
  }
  const parsed = draftSeedDocumentOutputSchema.safeParse(output);
  if (!parsed.success) {
    return undefined;
  }
  const input = job.input as Partial<DraftSeedDocumentJobInput>;
  if (!input.flowId) {
    return undefined;
  }
  return ctx.stores.proposals.create({
    title: parsed.data.title,
    targetPath: resolveProposalTargetPath(
      destinationSubpath(ctx.repositoryDeps(), input.destinationId),
      parsed.data.targetPath || parsed.data.title
    ),
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

// Completion handler for split_document jobs: a split-lens scan landed. Split is the
// inverse of dedupe: one broad source document becomes a parent plus focused docs,
// optionally cleaning up supplied neighbours. The changeset is constrained so the
// model may only update/delete the source and supplied neighbours, while genuinely
// new paths must be writes.
export async function createSplitProposalFromCompletedJob(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<Proposal | undefined> {
  if (!job || job.type !== "split_document") {
    return undefined;
  }
  const parsed = splitDocumentOutputSchema.safeParse(output);
  if (!parsed.success) {
    return undefined;
  }
  const input = job.input as Partial<SplitDocumentJobInput>;
  if (!input.path) {
    return undefined;
  }
  const { split, changeset, primaryPath, rationale } = parsed.data;
  if (!split || !changeset || !primaryPath || primaryPath !== input.path) {
    return undefined;
  }

  const primaryWrite = changeset.find((change) => change.path === primaryPath);
  if (!primaryWrite || primaryWrite.content === undefined) {
    return undefined;
  }

  const allowedExistingPaths = new Set([input.path, ...(input.neighbours ?? []).map((neighbour) => neighbour.path)]);
  const indexedExistingPaths = new Set(ctx.stores.knowledgeIndex.listDocuments().map((document) => document.path));
  for (const change of changeset) {
    if (allowedExistingPaths.has(change.path)) {
      continue;
    }
    if (indexedExistingPaths.has(change.path)) {
      return undefined;
    }
    if (change.delete || change.content === undefined) {
      return undefined;
    }
  }

  return ctx.stores.proposals.create({
    title: `Split: reorganise ${primaryPath}`,
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

// Completion handler for improve_document jobs: an improve-patrol scan landed. It
// creates a single-file, clusterless editorial-growth proposal only when the model
// explicitly improved the document and returned a changed full body. Idempotent on
// jobId, like the other patrol proposal flows.
export async function createImproveProposalFromCompletedJob(
  ctx: AppContext,
  job: JobView | undefined,
  output: unknown
): Promise<Proposal | undefined> {
  if (!job || job.type !== "improve_document") {
    return undefined;
  }
  const parsed = improveDocumentOutputSchema.safeParse(output);
  if (!parsed.success || !parsed.data.improved || !parsed.data.markdown) {
    return undefined;
  }
  const input = job.input as Partial<ImproveDocumentJobInput>;
  if (!input.path || parsed.data.markdown.trim() === input.content?.trim()) {
    return undefined;
  }
  return ctx.stores.proposals.create({
    title: `Improve: expand ${input.path}`,
    targetPath: input.path,
    markdown: parsed.data.markdown,
    rationale: parsed.data.rationale,
    evidence: [],
    flowId: input.flowId,
    destinationId: input.destinationId,
    jobId: job.id
  });
}
// Completion handler for publish_proposal jobs: records the validated git
// publication the watcher performed (branch, commit, optional remote/PR url) onto
// the linked proposal. Re-completing the same job writes the same payload again,
// while a later republish refreshes the stored branch tip.
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

  return ctx.stores.proposals.recordPublication(output.proposalId, {
    provider: "local-git",
    branchName: output.branchName,
    commitSha: output.commitSha,
    remoteUrl: output.remoteUrl,
    pullRequestUrl: output.pullRequestUrl,
    publishedAt: output.publishedAt
  });
}

// Derives the guard from the single source of truth so a new status (e.g. the
// once-missing "superseded") is recognised automatically — otherwise the list's
// ?status= filter silently ignores any value omitted here.
export function isProposalStatus(value: unknown): value is Proposal["status"] {
  return typeof value === "string" && (PROPOSAL_STATUSES as readonly string[]).includes(value);
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
