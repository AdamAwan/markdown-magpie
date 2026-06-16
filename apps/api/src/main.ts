import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type {
  AiExecutionMode,
  AiJob,
  AiJobType,
  AnswerQuestionJobInput,
  AnswerQuestionJobOutput,
  ChangesetChange,
  CrunchKnowledgeBaseJobInput,
  CrunchPlan,
  CrunchRun,
  CrunchRunTrigger,
  DraftMarkdownProposalJobInput,
  DraftMarkdownProposalJobOutput,
  GapCandidate,
  Proposal,
  RepositoryRef,
  QuestionFeedback,
  ScheduledTaskSettings,
  SourceDataContext,
  SuggestedGapCluster
} from "@magpie/core";
import { buildMockCrunchPlan, isValidCron, nextCronTime, resolveProposalTargetPath } from "@magpie/core";
import { ensureGitCheckout, fetchPullRequestStatus, LocalGitProposalPublisher, raisePullRequest } from "@magpie/git";
import { answerQuestion, createChatProvider, createEmbeddingProvider, type ChatProviderName, type EmbeddingProviderName } from "@magpie/retrieval";
import { DEFAULT_AI_JOB_CLAIM_TIMEOUT_MS, InMemoryAiJobQueue } from "./stores/ai-job-queue.js";
import { embedPendingSections } from "./stores/embed-sections.js";
import { assembleClusters, selectClustersToDraft, singletonCluster } from "./stores/gap-clustering.js";
import { InMemoryKnowledgeIndex } from "./stores/knowledge-index.js";
import {
  type ConfiguredKnowledgeFlow,
  type ConfiguredKnowledgeRepository,
  getConfiguredKnowledgeDestinations,
  getConfiguredKnowledgeFlows,
  getConfiguredKnowledgeRepositories,
  getConfiguredKnowledgeSources,
  resolveConfiguredRepositorySelection,
  resolveKnowledgeRepositorySelection
} from "./stores/knowledge-repositories.js";
import { DEFAULT_CRUNCH_CRON, InMemoryCrunchStore } from "./stores/crunch-store.js";
import { PostgresAiJobQueue } from "./stores/postgres-ai-job-queue.js";
import { PostgresCrunchStore } from "./stores/postgres-crunch-store.js";
import { PostgresKnowledgeStore } from "./stores/postgres-knowledge-store.js";
import { PostgresProposalStore } from "./stores/postgres-proposal-store.js";
import { PostgresQuestionLogStore } from "./stores/postgres-question-log-store.js";
import { PostgresScheduledTaskStore } from "./stores/postgres-scheduled-task-store.js";
import { InMemoryProposalStore } from "./stores/proposal-store.js";
import { InMemoryQuestionLogStore } from "./stores/question-log-store.js";
import { InMemoryScheduledTaskStore } from "./stores/scheduled-task-store.js";
import { apiLink, normalizeRelativePath, normalizeUploadPath, parseLimit, slugify, toPosixPath } from "./platform/paths.js";

const port = Number.parseInt(process.env.PORT ?? "4000", 10);
const aiJobClaimTimeoutMs = parseClaimTimeoutMs(process.env.AI_JOB_CLAIM_TIMEOUT_MS);
const aiJobs = createAiJobQueue();
const knowledgeStore =
  storeBackend("KNOWLEDGE_STORE") === "postgres"
    ? new PostgresKnowledgeStore(requireDatabaseUrl())
    : undefined;
const embeddingProvider = knowledgeStore ? createConfiguredEmbeddingProvider() : undefined;
const knowledgeIndex = knowledgeStore
  ? new InMemoryKnowledgeIndex(
      knowledgeStore,
      embeddingProvider
        ? { embeddingProvider, vectorSearch: knowledgeStore, onNotice: (message) => console.warn(message) }
        : {}
    )
  : new InMemoryKnowledgeIndex();
const questionLogs = createQuestionLogStore();
const proposals = createProposalStore();
const crunchRuns = createCrunchStore();
const scheduledTasks = createScheduledTaskStore();
let runtimeConfig = createInitialRuntimeConfig();
const configuredKnowledgeRepositories = getConfiguredKnowledgeRepositories();
const configuredKnowledgeSources = getConfiguredKnowledgeSources();
const configuredKnowledgeDestinations = getConfiguredKnowledgeDestinations();
const configuredKnowledgeFlows = getConfiguredKnowledgeFlows(
  process.env,
  configuredKnowledgeSources,
  configuredKnowledgeDestinations
);

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    writeJson(response, 500, { error: "internal_error", message });
  }
});

async function start(): Promise<void> {
  try {
    await syncConfiguredGitCheckouts();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`Failed to sync configured git repositories: ${message}`);
    process.exitCode = 1;
    return;
  }

  try {
    await knowledgeIndex.hydrate();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`Failed to hydrate knowledge index from storage: ${message}`);
  }

  server.listen(port, () => {
    console.log(`Markdown Magpie API listening on http://localhost:${port}/api`);
    logStartupConfig();
    startCrunchScheduler();
    startScheduledTaskScheduler();
  });
}

void start();

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const path = apiRoutePath(url.pathname);

  if (request.method === "OPTIONS") {
    writeJson(response, 204, undefined);
    return;
  }

  if (!path) {
    writeJson(response, 404, { error: "not_found" });
    return;
  }

  if (request.method === "GET" && path === "/health") {
    writeJson(response, 200, { ok: true, service: "markdown-magpie-api" });
    return;
  }

  if (request.method === "GET" && path === "/config") {
    writeJson(response, 200, getRuntimeConfig());
    return;
  }

  if (request.method === "POST" && path === "/config") {
    await handleUpdateRuntimeConfig(request, response);
    return;
  }

  if (request.method === "POST" && path === "/admin/reset") {
    await handleResetData(response);
    return;
  }

  if (request.method === "POST" && path === "/ask") {
    await handleAsk(request, response);
    return;
  }

  if (request.method === "POST" && path === "/repositories/index") {
    await handleIndexRepository(request, response);
    return;
  }

  if (request.method === "GET" && path === "/repositories") {
    writeJson(response, 200, { repositories: knowledgeIndex.listRepositories() });
    return;
  }

  if (request.method === "POST" && path === "/documents/upload") {
    await handleUploadDocuments(request, response);
    return;
  }

  if (request.method === "GET" && path === "/documents") {
    writeJson(response, 200, { documents: knowledgeIndex.listDocuments() });
    return;
  }

  if (request.method === "GET" && path === "/knowledge/stats") {
    writeJson(response, 200, knowledgeIndex.getStats());
    return;
  }

  if (request.method === "GET" && path === "/search") {
    const query = url.searchParams.get("q")?.trim();
    if (!query) {
      writeJson(response, 400, { error: "query_required" });
      return;
    }

    const ranked = await knowledgeIndex.search(query, parseLimit(url.searchParams.get("limit"), 5));
    writeJson(response, 200, { sections: ranked.map((result) => result.section), ranked });
    return;
  }

  if (request.method === "GET" && path === "/questions") {
    const limit = parseLimit(url.searchParams.get("limit"), 50);
    writeJson(response, 200, { questions: await questionLogs.list(limit) });
    return;
  }

  const questionMatch = /^\/questions\/([^/]+)$/.exec(path);
  if (request.method === "GET" && questionMatch) {
    const log = await questionLogs.get(questionMatch[1]);
    if (!log) {
      writeJson(response, 404, { error: "question_not_found" });
      return;
    }

    writeJson(response, 200, { question: log });
    return;
  }

  const feedbackMatch = /^\/questions\/([^/]+)\/feedback$/.exec(path);
  if (request.method === "POST" && feedbackMatch) {
    await handleQuestionFeedback(feedbackMatch[1], request, response);
    return;
  }

  const gapMatch = /^\/questions\/([^/]+)\/gap$/.exec(path);
  if (request.method === "POST" && gapMatch) {
    await handleRecordManualGap(gapMatch[1], request, response);
    return;
  }

  if (request.method === "DELETE" && gapMatch) {
    await handleClearManualGap(gapMatch[1], response);
    return;
  }

  if (request.method === "GET" && path === "/gaps/candidates") {
    const limit = parseLimit(url.searchParams.get("limit"), 50);
    writeJson(response, 200, { gaps: await questionLogs.listGapCandidates(limit) });
    return;
  }

  if (request.method === "GET" && path === "/gaps/clusters") {
    const limit = parseLimit(url.searchParams.get("limit"), 50);
    const candidates = await questionLogs.listGapCandidates(limit);
    const clusters = await clusterGapCandidates(candidates);
    writeJson(response, 200, { clusters });
    return;
  }

  if (request.method === "GET" && path === "/proposals") {
    const limit = parseLimit(url.searchParams.get("limit"), 50);
    const statusFilter = url.searchParams.get("status");
    const options = isProposalStatus(statusFilter) ? { status: statusFilter } : undefined;
    writeJson(response, 200, { proposals: await proposals.list(limit, options) });
    return;
  }

  if (request.method === "POST" && (path === "/proposals/from-gap" || path === "/proposals/from-gaps")) {
    await handleCreateProposalFromGaps(request, response);
    return;
  }

  const proposalMatch = /^\/proposals\/([^/]+)$/.exec(path);
  if (request.method === "GET" && proposalMatch) {
    const proposal = await proposals.get(proposalMatch[1]);
    if (!proposal) {
      writeJson(response, 404, { error: "proposal_not_found" });
      return;
    }

    writeJson(response, 200, { proposal });
    return;
  }

  const proposalStatusMatch = /^\/proposals\/([^/]+)\/status$/.exec(path);
  if (request.method === "POST" && proposalStatusMatch) {
    await handleUpdateProposalStatus(proposalStatusMatch[1], request, response);
    return;
  }

  const proposalPublishMatch = /^\/proposals\/([^/]+)\/publish$/.exec(path);
  if (request.method === "POST" && proposalPublishMatch) {
    await handlePublishProposal(proposalPublishMatch[1], response);
    return;
  }

  if (request.method === "GET" && path === "/crunch/runs") {
    const limit = parseLimit(url.searchParams.get("limit"), 20);
    writeJson(response, 200, { runs: await crunchRuns.listRuns(limit) });
    return;
  }

  if (request.method === "POST" && path === "/crunch/run") {
    await handleTriggerCrunch(request, response);
    return;
  }

  if (request.method === "GET" && path === "/crunch/settings") {
    writeJson(response, 200, { settings: await crunchSettingsForResponse() });
    return;
  }

  if (request.method === "POST" && path === "/crunch/settings") {
    await handleUpdateCrunchSettings(request, response);
    return;
  }

  const crunchRunPublishMatch = /^\/crunch\/runs\/([^/]+)\/publish$/.exec(path);
  if (request.method === "POST" && crunchRunPublishMatch) {
    await handlePublishCrunchRun(crunchRunPublishMatch[1], response);
    return;
  }

  if (request.method === "GET" && path === "/scheduled-tasks") {
    writeJson(response, 200, { tasks: await scheduledTasksForResponse() });
    return;
  }

  const scheduledTaskSettingsMatch = /^\/scheduled-tasks\/([^/]+)\/settings$/.exec(path);
  if (request.method === "POST" && scheduledTaskSettingsMatch) {
    await handleUpdateScheduledTaskSettings(scheduledTaskSettingsMatch[1], request, response);
    return;
  }

  const scheduledTaskRunMatch = /^\/scheduled-tasks\/([^/]+)\/run$/.exec(path);
  if (request.method === "POST" && scheduledTaskRunMatch) {
    await handleRunScheduledTask(scheduledTaskRunMatch[1], response);
    return;
  }

  const crunchRunMatch = /^\/crunch\/runs\/([^/]+)$/.exec(path);
  if (request.method === "GET" && crunchRunMatch) {
    const run = await crunchRuns.getRun(crunchRunMatch[1]);
    if (!run) {
      writeJson(response, 404, { error: "crunch_run_not_found" });
      return;
    }
    writeJson(response, 200, { run });
    return;
  }

  if (request.method === "POST" && path === "/ai-jobs") {
    await handleCreateJob(request, response);
    return;
  }

  if (request.method === "GET" && path === "/ai-jobs") {
    writeJson(response, 200, { jobs: await aiJobs.list() });
    return;
  }

  if (request.method === "POST" && path === "/ai-jobs/claim") {
    await handleClaimJob(request, response);
    return;
  }

  const completeMatch = /^\/ai-jobs\/([^/]+)\/complete$/.exec(path);
  if (request.method === "POST" && completeMatch) {
    await handleCompleteJob(completeMatch[1], request, response);
    return;
  }

  const failMatch = /^\/ai-jobs\/([^/]+)\/fail$/.exec(path);
  if (request.method === "POST" && failMatch) {
    await handleFailJob(failMatch[1], request, response);
    return;
  }

  const getMatch = /^\/ai-jobs\/([^/]+)$/.exec(path);
  if (request.method === "GET" && getMatch) {
    const job = await aiJobs.get(getMatch[1]);
    if (!job) {
      writeJson(response, 404, { error: "job_not_found" });
      return;
    }

    writeJson(response, 200, { job });
    return;
  }

  writeJson(response, 404, { error: "not_found" });
}

async function handleUpdateProposalStatus(
  proposalId: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const payload = await readJsonBody<{ status?: Proposal["status"] }>(request);

  if (!isProposalStatus(payload.status)) {
    writeJson(response, 400, { error: "valid_proposal_status_required" });
    return;
  }

  const proposal = await proposals.updateStatus(proposalId, payload.status);
  if (!proposal) {
    writeJson(response, 404, { error: "proposal_not_found" });
    return;
  }

  // Merging is the point at which the proposal's content lands in the knowledge
  // base: resolve the gaps it closed so they stop surfacing, then re-index the
  // destination so the new doc becomes searchable.
  if (proposal.status === "merged") {
    const { resolvedGapCount, reindexed } = await runMergeCascade(proposal);
    writeJson(response, 200, { proposal, resolvedGapCount, reindexed });
    return;
  }

  writeJson(response, 200, { proposal });
}

// The work that must happen once a proposal is merged, shared by the manual
// "Mark merged" endpoint and the pull-request poller: resolve its gaps and
// re-index the destination knowledge base.
async function runMergeCascade(proposal: Proposal): Promise<{ resolvedGapCount: number; reindexed: boolean }> {
  const resolvedGapCount = await resolveGapsForMergedProposal(proposal);
  const reindexed = await reindexDestinationForProposal(proposal);
  return { resolvedGapCount, reindexed };
}

// Resolves the gaps a merged proposal closed: precisely the rows whose question
// and summary the proposal recorded, so unrelated gaps on a multi-topic question
// are left untouched. Returns the number of gaps newly resolved.
async function resolveGapsForMergedProposal(proposal: Proposal): Promise<number> {
  const questionIds = proposal.triggeringQuestionIds ?? [];
  const summaries = splitGapSummaries(proposal.gapSummary);
  if (questionIds.length === 0 || summaries.length === 0) {
    return 0;
  }

  const resolved = await questionLogs.resolveGaps(questionIds, summaries, proposal.id);
  console.log(`Resolved ${resolved} gap(s) closed by merged proposal ${proposal.id}`);
  return resolved;
}

// Pulls the destination's default branch (where the PR merged) and re-indexes it
// so the merged document is immediately searchable. Best-effort: a failure here
// must not undo the merge, so it is logged and reported rather than thrown.
async function reindexDestinationForProposal(proposal: Proposal): Promise<boolean> {
  try {
    if (configuredKnowledgeDestinations.length > 0) {
      const destination = selectDestinationForProposal(proposal);
      if (!destination) {
        console.warn(`No destination matched merged proposal ${proposal.id}; skipping re-index.`);
        return false;
      }

      // For a git destination this also fetches and fast-forwards the checkout,
      // bringing in the just-merged commit before we re-index.
      const localPath = await resolveConfiguredRepositoryLocalPath(destination);
      await knowledgeIndex.indexLocalRepository({
        localPath,
        repositoryId: destination.id,
        name: destination.name
      });
    } else {
      const repository = await findRepositoryForProposal(proposal);
      if (!repository) {
        console.warn(`No repository matched merged proposal ${proposal.id}; skipping re-index.`);
        return false;
      }

      await knowledgeIndex.indexLocalRepository({
        localPath: repository.localPath,
        repositoryId: repository.id,
        name: repository.name
      });
    }

    console.log(`Re-indexed destination after merging proposal ${proposal.id}`);
    void embedSectionsInBackground();
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
async function publishReadyProposal(proposal: Proposal) {
  const repository = await findRepositoryForProposal(proposal);
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

    const updatedProposal = await proposals.recordPublication(proposal.id, {
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

async function handlePublishProposal(proposalId: string, response: ServerResponse): Promise<void> {
  const proposal = await proposals.get(proposalId);
  if (!proposal) {
    writeJson(response, 404, { error: "proposal_not_found" });
    return;
  }

  if (proposal.status !== "ready") {
    writeJson(response, 409, { error: "proposal_not_ready", message: "Only ready proposals can be published." });
    return;
  }

  const outcome = await publishReadyProposal(proposal);
  if (!outcome.ok) {
    writeJson(response, 409, { error: outcome.code, message: outcome.message });
    return;
  }

  writeJson(response, 200, {
    proposal: outcome.proposal,
    publication: outcome.publication,
    pullRequestUrl: outcome.pullRequestUrl,
    pullRequestWarning: outcome.pullRequestWarning
  });
}

// Human-facing PR description linking the merge back to the gaps it closes.
function buildPullRequestBody(proposal: Proposal): string {
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

async function handleUpdateRuntimeConfig(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const payload = await readJsonBody<{
    aiExecutionMode?: string;
    aiProvider?: string;
    ai?: {
      executionMode?: string;
      provider?: string;
    };
  }>(request);
  const nextExecutionMode = normalizeAiExecutionMode(payload.ai?.executionMode ?? payload.aiExecutionMode);
  const nextProvider = normalizeAiProvider(payload.ai?.provider ?? payload.aiProvider);

  if (!nextExecutionMode || !nextProvider) {
    writeJson(response, 400, { error: "valid_ai_runtime_config_required" });
    return;
  }

  const validationError = validateRuntimeAiConfig(nextExecutionMode, nextProvider);
  if (validationError) {
    writeJson(response, 400, { error: "unsupported_ai_runtime_config", message: validationError });
    return;
  }

  runtimeConfig = {
    aiExecutionMode: nextExecutionMode,
    aiProvider: nextProvider
  };
  writeJson(response, 200, getRuntimeConfig());
}

async function handleResetData(response: ServerResponse): Promise<void> {
  // Clear all user-generated state first, so even if re-seeding fails the app
  // is left in a clean (empty) but recoverable state.
  await questionLogs.reset();
  await proposals.reset();
  await crunchRuns.reset();
  await scheduledTasks.reset();
  await aiJobs.reset();
  if (knowledgeStore) {
    await knowledgeStore.reset();
  }
  knowledgeIndex.reset();

  // Reset runtime AI config back to the .env-derived defaults.
  runtimeConfig = createInitialRuntimeConfig();

  // Rebuild the knowledge bases from configuration.
  const seed = await seedConfiguredKnowledge();

  writeJson(response, 200, {
    ok: true,
    reindexed: seed.indexed,
    failures: seed.failures,
    stats: knowledgeIndex.getStats()
  });
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
async function draftProposalFromGapSummaries(
  rawSummaries: string[],
  overrides: { targetPath?: string; flowId?: string; sourceIds?: string[]; destinationId?: string } = {}
) {
  const uniqueRequested = [...new Set(rawSummaries.map((value) => value.trim()).filter((value) => value.length > 0))];

  if (uniqueRequested.length === 0) {
    return { ok: false as const, code: "gap_summary_required" };
  }

  const candidates = await questionLogs.listGapCandidates(200);
  const matched = uniqueRequested
    .map((summary) => candidates.find((candidate) => candidate.summary === summary))
    .filter((candidate): candidate is GapCandidate => Boolean(candidate));

  if (matched.length === 0) {
    return { ok: false as const, code: "gap_candidate_not_found" };
  }

  const gapSummaries = matched.map((candidate) => candidate.summary);
  const questionIds = [...new Set(matched.flatMap((candidate) => candidate.questionIds))];
  const label = gapSummaries.length === 1 ? `gap "${gapSummaries[0]}"` : `${gapSummaries.length} clustered gaps`;

  const logs = (await Promise.all(questionIds.map((id) => questionLogs.get(id)))).filter(
    (log): log is NonNullable<typeof log> => Boolean(log)
  );
  const evidence = dedupeCitations(logs.flatMap((log) => log.answer?.citations ?? []));
  const flow = selectFlow(overrides.flowId);
  const sourceIds = overrides.sourceIds ?? flow?.sourceIds;
  const destinationId = overrides.destinationId?.trim() || flow?.destinationId || defaultDestinationId();
  console.log(
    `Drafting proposal for ${label} (flow=${flow?.id ?? "none"}, destination=${destinationId ?? "none"}, ` +
      `provider=${runtimeConfig.aiProvider}, mode=${runtimeConfig.aiExecutionMode})`
  );
  const sourceContext = await collectSourceContext(sourceIds);
  const materialFiles = sourceContext.filter((context) => context.path && context.content !== "Source path does not exist.");
  if (materialFiles.length === 0) {
    console.warn(
      `Drafting proposal for ${label} with no real source files attached — ` +
        "the model will likely produce a placeholder. Check the source configuration and subpaths."
    );
  } else {
    console.log(`Proposal draft will use ${materialFiles.length} source file(s) as raw material.`);
  }
  const input: DraftMarkdownProposalJobInput = {
    gapSummaries,
    triggeringQuestions: logs.map((log) => log.question),
    evidence,
    sourceContext,
    destinationId,
    targetPath: overrides.targetPath?.trim() || undefined,
    provider: runtimeConfig.aiProvider,
    expectedOutput: "markdown_proposal"
  } as DraftMarkdownProposalJobInput & { provider: AiProviderName };

  if (runtimeConfig.aiExecutionMode === "direct") {
    const output = await draftMarkdownProposalDirect(input);
    const proposal = await proposals.create({
      ...output,
      targetPath: resolveProposalTargetPath(destinationSubpath(input.destinationId), output.title),
      evidence,
      gapSummary: joinGapSummaries(gapSummaries),
      triggeringQuestionIds: questionIds,
      destinationId: input.destinationId
    });

    console.log(`Created proposal ${proposal.id} directly for ${label} (target ${proposal.targetPath})`);
    return { ok: true as const, mode: "direct" as const, proposal };
  }

  const job = await aiJobs.enqueue("draft_markdown_proposal", {
    ...input,
    triggeringQuestionIds: questionIds
  });

  console.log(`Enqueued draft_markdown_proposal job ${job.id} for ${label}`);
  return { ok: true as const, mode: "queue" as const, job };
}

async function handleCreateProposalFromGaps(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const payload = await readJsonBody<{
    summary?: string;
    summaries?: string[];
    targetPath?: string;
    flowId?: string;
    sourceIds?: string[];
    destinationId?: string;
  }>(request);

  const requested = [...(payload.summaries ?? []), ...(payload.summary ? [payload.summary] : [])];
  const outcome = await draftProposalFromGapSummaries(requested, {
    targetPath: payload.targetPath,
    flowId: payload.flowId,
    sourceIds: payload.sourceIds,
    destinationId: payload.destinationId
  });

  if (!outcome.ok) {
    writeJson(response, outcome.code === "gap_summary_required" ? 400 : 404, { error: outcome.code });
    return;
  }

  if (outcome.mode === "direct") {
    writeJson(response, 201, { proposal: outcome.proposal });
    return;
  }

  writeJson(response, 202, {
    job: outcome.job,
    links: {
      status: apiLink(`/ai-jobs/${outcome.job.id}`),
      proposals: apiLink("/proposals")
    }
  });
}

// Stored on the proposal as a human-readable record of which gaps it closes.
function joinGapSummaries(summaries: string[]): string {
  return summaries.join("\n");
}

// Inverse of joinGapSummaries: recovers the individual gap summaries a proposal
// closes from its stored newline-joined record.
function splitGapSummaries(gapSummary: string | undefined): string[] {
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

async function handleQuestionFeedback(
  questionId: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const payload = await readJsonBody<{ feedback?: QuestionFeedback }>(request);

  if (!isQuestionFeedback(payload.feedback)) {
    writeJson(response, 400, { error: "valid_feedback_required" });
    return;
  }

  const question = await questionLogs.recordFeedback(questionId, payload.feedback);
  if (!question) {
    writeJson(response, 404, { error: "question_not_found" });
    return;
  }

  writeJson(response, 200, { question });
}

async function handleRecordManualGap(
  questionId: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const payload = await readJsonBody<{ summary?: string }>(request);
  const summary = typeof payload.summary === "string" ? payload.summary : undefined;

  const question = await questionLogs.recordManualGap(questionId, summary);
  if (!question) {
    writeJson(response, 404, { error: "question_not_found" });
    return;
  }

  writeJson(response, 200, { question });
}

async function handleClearManualGap(questionId: string, response: ServerResponse): Promise<void> {
  const question = await questionLogs.clearManualGap(questionId);
  if (!question) {
    writeJson(response, 404, { error: "question_not_found" });
    return;
  }

  writeJson(response, 200, { question });
}

async function handleAsk(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const payload = await readJsonBody<{ question?: string }>(request);
  const question = payload.question?.trim();

  if (!question) {
    writeJson(response, 400, { error: "question_required" });
    return;
  }

  if (runtimeConfig.aiExecutionMode === "queue") {
    const sections = await knowledgeIndex.search(question, 5);
    const log = await questionLogs.record({
      question,
      executionMode: runtimeConfig.aiExecutionMode,
      chatProvider: runtimeConfig.aiProvider,
      retrievedSectionIds: sections.map((ranked) => ranked.section.id)
    });
    const input: AnswerQuestionJobInput = {
      questionLogId: log.id,
      question,
      context: sections.map(({ section }) => ({
        sectionId: section.id,
        path: section.path,
        heading: section.heading,
        content: section.content
      })),
      provider: runtimeConfig.aiProvider,
      expectedOutput: "answer_result"
    } as AnswerQuestionJobInput & { provider: AiProviderName };
    const job = await aiJobs.enqueue("answer_question", input);
    writeJson(response, 202, {
      mode: "queue",
      questionId: log.id,
      job,
      links: {
        question: apiLink(`/questions/${log.id}`),
        status: apiLink(`/ai-jobs/${job.id}`)
      }
    });
    return;
  }

  const result = await answerQuestion(
    question,
    knowledgeIndex,
    createConfiguredChatProvider(runtimeConfig.aiProvider)
  );
  const log = await questionLogs.record({
    question,
    executionMode: runtimeConfig.aiExecutionMode,
    chatProvider: runtimeConfig.aiProvider,
    answer: result,
    retrievedSectionIds: result.citations.map((citation) => citation.sectionId)
  });

  writeJson(response, 200, {
    mode: runtimeConfig.aiExecutionMode,
    questionId: log.id,
    result
  });
}

async function resolveIndexSelection(payload: {
  flowId?: string;
  localPath?: string;
  repositoryId?: string;
  name?: string;
}): Promise<{ localPath: string; repositoryId?: string; name?: string }> {
  const indexableDestinations = configuredKnowledgeDestinations.filter(
    (destination) => destination.kind === "local" || destination.kind === "git"
  );
  if (indexableDestinations.length > 0) {
    const configured = selectDestinationForIndex(payload, indexableDestinations);
    const localPath = await resolveConfiguredRepositoryLocalPath(configured);
    return { localPath, repositoryId: configured.id, name: configured.name };
  }
  if (configuredKnowledgeDestinations.length > 0) {
    throw new Error("configured_repository_not_indexable");
  }
  return resolveKnowledgeRepositorySelection(payload, configuredKnowledgeRepositories);
}

async function indexRepositoryForPayload(payload: {
  flowId?: string;
  localPath?: string;
  repositoryId?: string;
  name?: string;
}): Promise<Awaited<ReturnType<typeof knowledgeIndex.indexLocalRepository>>> {
  const selection = await resolveIndexSelection(payload);
  return knowledgeIndex.indexLocalRepository({
    localPath: selection.localPath,
    repositoryId: selection.repositoryId,
    name: selection.name
  });
}

async function handleIndexRepository(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const payload = await readJsonBody<{ flowId?: string; localPath?: string; repositoryId?: string; name?: string }>(request);

  let selection: { localPath: string; repositoryId?: string; name?: string };
  try {
    selection = await resolveIndexSelection(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "configured_repository_required";
    writeJson(response, 400, { error: knowledgeRepositoryErrorCode(message), message });
    return;
  }

  const summary = await knowledgeIndex.indexLocalRepository({
    localPath: selection.localPath,
    repositoryId: selection.repositoryId,
    name: selection.name
  });

  writeJson(response, 200, summary);
  void embedSectionsInBackground();
}

function configuredIndexPayloads(): Array<{ flowId?: string; repositoryId?: string }> {
  if (configuredKnowledgeFlows.length > 0) {
    return configuredKnowledgeFlows.map((flow) => ({ flowId: flow.id }));
  }

  const indexableDestinations = configuredKnowledgeDestinations.filter(
    (destination) => destination.kind === "local" || destination.kind === "git"
  );
  if (indexableDestinations.length > 0) {
    return indexableDestinations.map((destination) => ({ repositoryId: destination.id }));
  }

  return configuredKnowledgeRepositories.map((repository) => ({ repositoryId: repository.id }));
}

async function seedConfiguredKnowledge(): Promise<{ indexed: number; failures: Array<{ target: string; message: string }> }> {
  await syncConfiguredGitCheckouts();

  const payloads = configuredIndexPayloads();
  const failures: Array<{ target: string; message: string }> = [];
  let indexed = 0;

  for (const payload of payloads) {
    const target = payload.flowId ?? payload.repositoryId ?? "default";
    try {
      await indexRepositoryForPayload(payload);
      indexed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "index_failed";
      console.warn(`Failed to re-index ${target}: ${message}`);
      failures.push({ target, message });
    }
  }

  void embedSectionsInBackground();
  return { indexed, failures };
}

function selectDestinationForIndex(
  payload: { flowId?: string; repositoryId?: string; localPath?: string },
  destinations: ConfiguredKnowledgeRepository[]
): ConfiguredKnowledgeRepository {
  if (payload.localPath?.trim()) {
    throw new Error("localPath is not accepted when knowledge repositories are configured");
  }

  const flowId = payload.flowId?.trim();
  if (flowId) {
    const flow = configuredKnowledgeFlows.find((candidate) => candidate.id === flowId);
    const destination = flow ? destinations.find((candidate) => candidate.id === flow.destinationId) : undefined;
    if (!destination) {
      throw new Error("configured_repository_required");
    }
    return destination;
  }

  return resolveConfiguredRepositorySelection(payload, destinations).repository;
}

async function handleUploadDocuments(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const payload = await readJsonBody<{
    repositoryId?: string;
    name?: string;
    documents?: Array<{ path?: string; content?: string }>;
  }>(request);
  const documents = (payload.documents ?? [])
    .map((document) => ({
      path: normalizeUploadPath(document.path),
      content: document.content ?? ""
    }))
    .filter((document) => document.path && document.content.trim());

  if (documents.length === 0) {
    writeJson(response, 400, { error: "markdown_documents_required" });
    return;
  }

  if (documents.some((document) => document.content.length > 250_000)) {
    writeJson(response, 413, { error: "markdown_document_too_large" });
    return;
  }

  const summary = await knowledgeIndex.indexMarkdownDocuments({
    repositoryId: payload.repositoryId?.trim() || "uploaded",
    name: payload.name?.trim() || "Uploaded Markdown",
    documents: documents.map((document) => ({
      path: document.path,
      content: document.content
    }))
  });

  writeJson(response, 201, summary);
  void embedSectionsInBackground();
}

async function handleCreateJob(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const payload = await readJsonBody<{ type?: AiJobType; input?: unknown }>(request);

  if (!payload.type || !isAiJobType(payload.type)) {
    writeJson(response, 400, { error: "valid_job_type_required" });
    return;
  }

  const job = await aiJobs.enqueue(payload.type, payload.input ?? {});
  writeJson(response, 201, { job });
}

async function handleClaimJob(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const payload = await readJsonBody<{ workerName?: string; acceptedTypes?: AiJobType[] }>(request);
  const workerName = payload.workerName?.trim();

  if (!workerName) {
    writeJson(response, 400, { error: "worker_name_required" });
    return;
  }

  const acceptedTypes = (payload.acceptedTypes ?? []).filter(isAiJobType);
  if (acceptedTypes.length === 0) {
    writeJson(response, 400, { error: "accepted_types_required" });
    return;
  }

  const job = await aiJobs.claimNext(workerName, acceptedTypes);
  writeJson(response, 200, { job: job ?? null });
}

async function handleCompleteJob(
  jobId: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const payload = await readJsonBody<{ output?: unknown }>(request);

  try {
    const existingJob = await aiJobs.get(jobId);
    if (!existingJob) {
      writeJson(response, 404, { error: "job_not_found" });
      return;
    }

    await aiJobs.complete(jobId, payload.output ?? {});
    await updateQuestionLogFromCompletedJob(existingJob, payload.output);
    await createProposalFromCompletedJob(existingJob, payload.output);
    await attachCrunchPlanFromCompletedJob(existingJob, payload.output);
    writeJson(response, 200, { job: await aiJobs.get(jobId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected completion failure";
    writeJson(response, 500, { error: "job_completion_failed", message });
  }
}

async function updateQuestionLogFromCompletedJob(job: AiJob | undefined, output: unknown): Promise<void> {
  if (!job || job.type !== "answer_question" || !isAnswerQuestionJobOutput(output)) {
    return;
  }

  const input = job.input as Partial<AnswerQuestionJobInput> & { provider?: string };
  if (!input.questionLogId) {
    return;
  }

  await questionLogs.updateAnswer(input.questionLogId, {
    answer: output,
    chatProvider: typeof input.provider === "string" ? input.provider : (job.claimedBy ?? "watcher")
  });
}

async function handleFailJob(jobId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const payload = await readJsonBody<{ error?: string }>(request);

  try {
    const failingJob = await aiJobs.get(jobId);
    await aiJobs.fail(jobId, payload.error ?? "Unknown watcher failure");
    if (failingJob?.type === "crunch_knowledge_base") {
      const run = await crunchRuns.getRunByJobId(jobId);
      if (run) {
        await crunchRuns.failRun(run.id, payload.error ?? "Crunch job failed");
      }
    }
    writeJson(response, 200, { job: await aiJobs.get(jobId) });
  } catch {
    writeJson(response, 404, { error: "job_not_found" });
  }
}

async function readJsonBody<T>(request: NodeJS.ReadableStream): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-origin": "*",
    "content-type": "application/json"
  });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

function getRuntimeConfig() {
  const availableProviders = getConfiguredAiProviders();
  return {
    api: {
      port,
      aiExecutionMode: runtimeConfig.aiExecutionMode,
      aiProvider: runtimeConfig.aiProvider,
      nodeEnv: process.env.NODE_ENV ?? "development"
    },
    stores: {
      storageBackend: storageBackend(),
      knowledgeStore: storeBackend("KNOWLEDGE_STORE"),
      questionLogStore: storeBackend("QUESTION_LOG_STORE"),
      proposalStore: storeBackend("PROPOSAL_STORE"),
      aiJobQueue: storeBackend("AI_JOB_QUEUE"),
      databaseUrl: maskConnectionString(process.env.DATABASE_URL)
    },
    knowledge: {
      repositoryPath: process.env.KNOWLEDGE_REPO_PATH ?? null,
      repositories: configuredKnowledgeRepositories,
      sources: configuredKnowledgeSources,
      destinations: configuredKnowledgeDestinations,
      flows: configuredKnowledgeFlows,
      checkoutRoot: checkoutRoot()
    },
    providers: {
      llmProvider: process.env.LLM_PROVIDER ?? "mock",
      embeddingProvider: embeddingProviderName() ?? "mock",
      gitProvider: process.env.GIT_PROVIDER ?? "local",
      openAiCompatible: {
        baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL || null,
        model: process.env.OPENAI_COMPATIBLE_MODEL || null,
        apiKey: secretState(process.env.OPENAI_COMPATIBLE_API_KEY),
        embeddingBaseUrl: process.env.OPENAI_COMPATIBLE_EMBEDDING_BASE_URL || null,
        embeddingModel: process.env.OPENAI_COMPATIBLE_EMBEDDING_MODEL || null,
        embeddingApiKey: secretState(process.env.OPENAI_COMPATIBLE_EMBEDDING_API_KEY)
      },
      azureOpenAi: {
        endpoint: process.env.AZURE_OPENAI_ENDPOINT || null,
        chatDeployment: process.env.AZURE_OPENAI_CHAT_DEPLOYMENT || null,
        embeddingDeployment: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || null,
        apiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-10-21",
        apiKey: secretState(process.env.AZURE_OPENAI_API_KEY)
      },
      gitSecrets: {
        githubToken: secretState(process.env.GITHUB_TOKEN),
        azureDevopsPat: secretState(process.env.AZURE_DEVOPS_PAT)
      }
    },
    aiRuntime: {
      executionMode: runtimeConfig.aiExecutionMode,
      provider: runtimeConfig.aiProvider,
      executionModes: ["direct", "queue"],
      providers: availableProviders,
      directProviders: availableProviders.filter((provider) => provider.supportsDirect).map((provider) => provider.name),
      queueProviders: availableProviders.filter((provider) => provider.supportsQueue).map((provider) => provider.name)
    },
    retrieval: (() => {
      const { mode, reason } = retrievalMode();
      return {
        mode,
        reason,
        embeddingProvider: embeddingProviderName() ?? null
      };
    })(),
    watcher: {
      name: process.env.WATCHER_NAME ?? null,
      pollIntervalMs: process.env.WATCHER_POLL_INTERVAL_MS ?? null,
      aiJobProvider: runtimeConfig.aiProvider,
      agentApiTimeoutMs: process.env.AGENT_API_TIMEOUT_MS ?? null,
      claimTimeoutMs: aiJobClaimTimeoutMs
    }
  };
}

// Startup summary so operators can trace which options resolved and which
// providers/credentials are (not) wired up. Built from getRuntimeConfig() so it
// reuses the same secret masking — values are reported as "set"/"not set", never
// printed. Set LOG_STARTUP_CONFIG=false to suppress.
function logStartupConfig(): void {
  if (process.env.LOG_STARTUP_CONFIG === "false") {
    return;
  }

  const cfg = getRuntimeConfig();
  const lines: string[] = [];
  const section = (title: string) => lines.push(`  ${title}`);
  const add = (label: string, value: unknown) => lines.push(`    ${`${label}`.padEnd(26)}: ${value}`);

  section("Stores (memory | postgres)");
  add("storage backend (default)", cfg.stores.storageBackend);
  add("knowledge store", cfg.stores.knowledgeStore);
  add("question log store", cfg.stores.questionLogStore);
  add("proposal store", cfg.stores.proposalStore);
  add("ai job queue", cfg.stores.aiJobQueue);
  add("database url", cfg.stores.databaseUrl ?? "not set");

  section("AI execution");
  add("execution mode", cfg.aiRuntime.executionMode);
  add("active provider", cfg.aiRuntime.provider);
  add("configured providers", cfg.aiRuntime.providers.map((provider) => provider.name).join(", "));
  add("usable in direct mode", cfg.aiRuntime.directProviders.join(", ") || "none");
  add("usable in queue mode", cfg.aiRuntime.queueProviders.join(", ") || "none");

  section("Chat provider (openai-compatible)");
  add("base url", cfg.providers.openAiCompatible.baseUrl ?? "not set");
  add("model", cfg.providers.openAiCompatible.model ?? "not set");
  add("api key", cfg.providers.openAiCompatible.apiKey);

  section("Embeddings / retrieval");
  add("retrieval mode", `${cfg.retrieval.mode} (${cfg.retrieval.reason})`);
  add("embedding provider", cfg.retrieval.embeddingProvider ?? "none");
  add("embedding base url", cfg.providers.openAiCompatible.embeddingBaseUrl ?? "falls back to chat");
  add("embedding model", cfg.providers.openAiCompatible.embeddingModel ?? "not set");
  add("embedding api key", cfg.providers.openAiCompatible.embeddingApiKey);

  section("Azure OpenAI");
  add("endpoint", cfg.providers.azureOpenAi.endpoint ?? "not set");
  add("chat deployment", cfg.providers.azureOpenAi.chatDeployment ?? "not set");
  add("embedding deployment", cfg.providers.azureOpenAi.embeddingDeployment ?? "not set");
  add("api key", cfg.providers.azureOpenAi.apiKey);

  section("Git");
  add("provider (display only)", cfg.providers.gitProvider);
  add("github token", cfg.providers.gitSecrets.githubToken);
  add("azure devops pat", cfg.providers.gitSecrets.azureDevopsPat);

  section("Knowledge");
  add("sources", cfg.knowledge.sources.map((repo) => `${repo.id}[${repo.kind}]`).join(", ") || "none");
  add("destinations", cfg.knowledge.destinations.map((repo) => `${repo.id}[${repo.kind}]`).join(", ") || "none");
  add(
    "flows",
    cfg.knowledge.flows.map((flow) => `${flow.id}(${flow.sourceIds.join("+")}->${flow.destinationId})`).join(", ") || "none"
  );
  add("checkout root", cfg.knowledge.checkoutRoot);

  section("Watcher");
  add("name", cfg.watcher.name ?? "not set");
  add("poll interval ms", cfg.watcher.pollIntervalMs ?? "default (2000)");

  console.log(`Resolved configuration (env=${cfg.api.nodeEnv}):\n${lines.join("\n")}`);
}

function maskConnectionString(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    if (url.password) {
      url.password = "****";
    }
    if (url.username) {
      url.username = `${url.username.slice(0, 1)}***`;
    }
    return url.toString();
  } catch {
    return secretState(value);
  }
}

function knowledgeRepositoryErrorCode(message: string): string {
  if (message === "local_path_required") {
    return "local_path_required";
  }

  if (message.includes("localPath is not accepted")) {
    return "local_path_not_allowed";
  }

  if (message.includes("cannot_be_checked_out") || message.includes("repository_url_required") || message === "configured_repository_not_indexable") {
    return "configured_repository_not_indexable";
  }

  return "configured_repository_required";
}

function secretState(value: string | undefined): "set" | "not set" {
  return value ? "set" : "not set";
}

async function draftMarkdownProposalDirect(input: DraftMarkdownProposalJobInput): Promise<DraftMarkdownProposalJobOutput> {
  if (runtimeConfig.aiProvider === "mock") {
    return createMockMarkdownProposal(input);
  }

  const response = await createConfiguredChatProvider(runtimeConfig.aiProvider).complete({
    system:
      "Draft a conservative Markdown knowledge base proposal for the provided gap. Return JSON only with this shape: " +
      '{"title":"string","targetPath":"string","markdown":"string","rationale":"string"}. ' +
      "Include frontmatter with title and status: draft in the markdown field.",
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

// Suggests semantic groupings of gap candidates for the review UI. This is a
// read-only suggestion step, so it always runs synchronously against the chat
// provider regardless of the direct/queue execution mode used for drafting. The
// mock provider cannot cluster semantically (its embeddings/answers are
// deterministic stubs), so it — and any non-chat provider — falls back to one
// cluster per gap, which the reviewer can still merge by hand.
async function clusterGapCandidates(candidates: GapCandidate[]): Promise<SuggestedGapCluster[]> {
  const canCluster =
    runtimeConfig.aiProvider === "openai-compatible" || runtimeConfig.aiProvider === "azure-openai";
  if (!canCluster || candidates.length <= 1) {
    return candidates.map((candidate) => singletonCluster(candidate));
  }

  try {
    return await requestGapClusters(candidates);
  } catch (error) {
    const message = error instanceof Error ? error.message : "clustering failed";
    console.warn(`Gap clustering failed (${message}); falling back to one cluster per gap.`);
    return candidates.map((candidate) => singletonCluster(candidate));
  }
}

async function requestGapClusters(candidates: GapCandidate[]): Promise<SuggestedGapCluster[]> {
  const response = await createConfiguredChatProvider(runtimeConfig.aiProvider).complete({
    system:
      "Group related knowledge-base gaps that a single Markdown article could resolve. " +
      "Two gaps belong together only when one proposal would naturally answer both. " +
      'Return JSON only with this shape: {"clusters":[{"title":"string","summaries":["string"],"rationale":"string"}]}. ' +
      "Use the gap summary strings exactly as provided. Every input summary must appear in exactly one cluster. " +
      "Prefer several small, focused clusters over one broad cluster.",
    messages: [
      {
        role: "user",
        content: JSON.stringify({ gaps: candidates.map((candidate) => candidate.summary) }, null, 2)
      }
    ]
  });

  return assembleClusters(candidates, parseJsonObject(response.content));
}

function createMockMarkdownProposal(input: DraftMarkdownProposalJobInput): DraftMarkdownProposalJobOutput {
  const title = titleFromGapSummary(input.gapSummaries[0] ?? "");
  const targetPath = resolveProposalTargetPath(destinationSubpath(input.destinationId), title);
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

function titleFromGapSummary(summary: string): string {
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

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(value);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        return undefined;
      }
    }

    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(value.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
  }

  return undefined;
}

async function createProposalFromCompletedJob(job: AiJob | undefined, output: unknown): Promise<void> {
  if (!job || job.type !== "draft_markdown_proposal" || !isDraftMarkdownProposalJobOutput(output)) {
    return;
  }

  const input = job.input as Partial<DraftMarkdownProposalJobInput> & {
    triggeringQuestionIds?: string[];
  };

  await proposals.create({
    ...output,
    targetPath: resolveProposalTargetPath(destinationSubpath(input.destinationId), output.title),
    evidence: input.evidence ?? [],
    gapSummary: input.gapSummaries ? joinGapSummaries(input.gapSummaries) : undefined,
    triggeringQuestionIds: input.triggeringQuestionIds,
    destinationId: input.destinationId,
    jobId: job.id
  });
}

// ---------------------------------------------------------------------------
// Crunch — scheduled knowledge-base tidying
// ---------------------------------------------------------------------------

async function handleTriggerCrunch(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const payload = await readJsonBody<{ flowId?: string }>(request);
  try {
    const run = await triggerCrunchRun({ flowId: payload.flowId?.trim() || undefined, trigger: "manual" });
    writeJson(response, run.status === "failed" ? 502 : 200, { run });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Crunch run failed to start";
    writeJson(response, 500, { error: "crunch_run_failed", message });
  }
}

async function handleUpdateCrunchSettings(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const payload = await readJsonBody<{ flowId?: string; enabled?: boolean; cron?: string }>(request);
  const cron = typeof payload.cron === "string" ? payload.cron.trim() : "";
  if (!isValidCron(cron)) {
    writeJson(response, 400, {
      error: "valid_cron_required",
      message: "cron must be a standard 5-field expression, e.g. \"0 2 * * *\"."
    });
    return;
  }

  await crunchRuns.updateSettings(payload.flowId?.trim() || undefined, {
    enabled: Boolean(payload.enabled),
    cron
  });
  writeJson(response, 200, { settings: await crunchSettingsForResponse() });
}

// Always returns one settings row per configured flow (or a single default-flow
// row when no flows are configured), merging in any stored schedule so the UI
// can render a control even before the schedule has been saved once.
async function crunchSettingsForResponse() {
  const stored = await crunchRuns.listSettings();
  const byFlow = new Map(stored.map((setting) => [setting.flowId ?? "", setting]));
  const fallback = (flowId: string | undefined) =>
    byFlow.get(flowId ?? "") ?? { flowId, enabled: false, cron: DEFAULT_CRUNCH_CRON };

  if (configuredKnowledgeFlows.length > 0) {
    return configuredKnowledgeFlows.map((flow) => fallback(flow.id));
  }

  return [fallback(undefined)];
}

async function handlePublishCrunchRun(runId: string, response: ServerResponse): Promise<void> {
  const run = await crunchRuns.getRun(runId);
  if (!run) {
    writeJson(response, 404, { error: "crunch_run_not_found" });
    return;
  }

  if (run.status !== "completed" || !run.plan) {
    writeJson(response, 409, {
      error: "crunch_run_not_publishable",
      message: "Only completed crunch runs with a plan can be published."
    });
    return;
  }

  const changes = changesetFromPlan(run.plan);
  if (changes.length === 0) {
    writeJson(response, 409, {
      error: "crunch_run_empty_plan",
      message: "This crunch plan does not change any files."
    });
    return;
  }

  const repository = await findRepositoryForDestination(run.destinationId);
  if (!repository) {
    writeJson(response, 409, {
      error: "crunch_repository_not_found",
      message: "No indexed Git repository matches this crunch run's destination."
    });
    return;
  }

  if (repository.git?.scope === "not-git" || !repository.git?.workTreeRoot) {
    writeJson(response, 409, {
      error: "crunch_repository_not_git",
      message: "The matched repository is not a Git checkout."
    });
    return;
  }

  try {
    const publisher = new LocalGitProposalPublisher();
    const publication = await publisher.publishChangeset({
      repository,
      branchName: crunchBranchName(run),
      title: `docs: crunch tidy (${run.plan.operations.length} operation${run.plan.operations.length === 1 ? "" : "s"})`,
      changes
    });
    const updatedRun = await crunchRuns.recordRunPublication(run.id, {
      provider: "local-git",
      branchName: publication.branchName,
      commitSha: publication.commitSha,
      remoteUrl: publication.remoteUrl,
      publishedAt: new Date().toISOString()
    });

    writeJson(response, 200, { run: updatedRun, publication });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Crunch publish failed";
    writeJson(response, 409, { error: "crunch_publish_failed", message });
  }
}

// Shared by the manual trigger endpoint and the scheduler. In direct mode the
// plan is produced synchronously; in queue mode a job is enqueued and the run is
// completed later by the watcher via attachCrunchPlanFromCompletedJob().
async function triggerCrunchRun(options: { flowId?: string; trigger: CrunchRunTrigger }): Promise<CrunchRun> {
  const flow = selectFlow(options.flowId);
  const flowId = flow?.id ?? options.flowId;
  const destinationId = flow?.destinationId ?? defaultDestinationId();
  const documents = gatherCrunchDocuments(destinationId);
  const input = {
    flowId,
    destinationId,
    documents,
    expectedOutput: "crunch_plan",
    provider: runtimeConfig.aiProvider
  } satisfies CrunchKnowledgeBaseJobInput & { provider: AiProviderName };

  console.log(
    `Crunch run requested (trigger=${options.trigger}, flow=${flowId ?? "default"}, ` +
      `destination=${destinationId ?? "none"}, documents=${documents.length}, ` +
      `provider=${runtimeConfig.aiProvider}, mode=${runtimeConfig.aiExecutionMode})`
  );

  if (runtimeConfig.aiExecutionMode === "direct") {
    try {
      const plan = await crunchKnowledgeBaseDirect(input);
      return crunchRuns.createRun({
        flowId,
        destinationId,
        trigger: options.trigger,
        documentCount: documents.length,
        status: "completed",
        plan
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Crunch planning failed";
      return crunchRuns.createRun({
        flowId,
        destinationId,
        trigger: options.trigger,
        documentCount: documents.length,
        status: "failed",
        error: message
      });
    }
  }

  const job = await aiJobs.enqueue("crunch_knowledge_base", input);
  return crunchRuns.createRun({
    flowId,
    destinationId,
    trigger: options.trigger,
    documentCount: documents.length,
    status: "running",
    jobId: job.id
  });
}

function gatherCrunchDocuments(destinationId: string | undefined) {
  const documents = knowledgeIndex.listDocuments();
  const scoped = destinationId ? documents.filter((document) => document.repositoryId === destinationId) : documents;
  return scoped.map((document) => ({ path: document.path, content: document.content }));
}

async function crunchKnowledgeBaseDirect(input: CrunchKnowledgeBaseJobInput): Promise<CrunchPlan> {
  if (runtimeConfig.aiProvider === "mock") {
    return buildMockCrunchPlan(input.documents);
  }

  const response = await createConfiguredChatProvider(runtimeConfig.aiProvider).complete({
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

async function attachCrunchPlanFromCompletedJob(job: AiJob | undefined, output: unknown): Promise<void> {
  if (!job || job.type !== "crunch_knowledge_base") {
    return;
  }

  const run = await crunchRuns.getRunByJobId(job.id);
  if (!run) {
    return;
  }

  if (isCrunchPlan(output)) {
    await crunchRuns.completeRun(run.id, output);
  } else {
    await crunchRuns.failRun(run.id, "Crunch job returned an invalid plan");
  }
}

function isCrunchPlan(value: unknown): value is CrunchPlan {
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
function changesetFromPlan(plan: CrunchPlan): ChangesetChange[] {
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

async function findRepositoryForDestination(destinationId: string | undefined): Promise<RepositoryRef | undefined> {
  if (configuredKnowledgeDestinations.length > 0) {
    const destination = destinationId
      ? configuredKnowledgeDestinations.find((candidate) => candidate.id === destinationId)
      : configuredKnowledgeDestinations.length === 1
        ? configuredKnowledgeDestinations[0]
        : undefined;
    if (!destination) {
      return undefined;
    }

    const localPath = await resolveConfiguredRepositoryLocalPath(destination);
    const summary = await knowledgeIndex.indexLocalRepository({
      localPath,
      repositoryId: destination.id,
      name: destination.name
    });
    void embedSectionsInBackground();
    return summary.repository;
  }

  const repositories = knowledgeIndex.listRepositories();
  return repositories.length === 1
    ? repositories[0]
    : repositories.find((repository) => normalizeRelativePath(repository.git?.relativePathFromRoot) === ".");
}

function crunchBranchName(run: CrunchRun): string {
  return `magpie/crunch-${run.id.slice(0, 8)}`;
}

let crunchTickInFlight = false;

function startCrunchScheduler(): void {
  const tickMs = Number.parseInt(process.env.CRUNCH_SCHEDULER_TICK_MS ?? "60000", 10);
  const timer = setInterval(() => void crunchSchedulerTick(), Number.isFinite(tickMs) && tickMs > 0 ? tickMs : 60_000);
  // Don't keep the process alive solely for the scheduler.
  timer.unref?.();
  console.log(`Crunch scheduler started (tick ${Number.isFinite(tickMs) && tickMs > 0 ? tickMs : 60_000}ms)`);
}

// One tick: fire any enabled schedule whose nextRunAt is due, then reschedule it.
// Re-entrancy guarded so a slow direct run can't overlap the next tick.
async function crunchSchedulerTick(): Promise<void> {
  if (crunchTickInFlight) {
    return;
  }
  crunchTickInFlight = true;
  try {
    const now = Date.now();
    for (const setting of await crunchRuns.listSettings()) {
      if (!setting.enabled || !setting.nextRunAt) {
        continue;
      }
      if (new Date(setting.nextRunAt).getTime() > now) {
        continue;
      }

      const nextRunAt = nextCronTime(setting.cron, new Date(now));
      if (!nextRunAt) {
        console.warn(`Crunch schedule for flow ${setting.flowId ?? "default"} has an invalid cron "${setting.cron}"; skipping.`);
        continue;
      }
      // Reschedule before running so a failure or restart can't cause a tight retry loop.
      await crunchRuns.touchSchedule(setting.flowId, new Date(now).toISOString(), nextRunAt.toISOString());
      console.log(`Crunch schedule due for flow ${setting.flowId ?? "default"}; starting scheduled run.`);
      try {
        await triggerCrunchRun({ flowId: setting.flowId, trigger: "scheduled" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "scheduled crunch run failed";
        console.error(`Scheduled crunch run failed for flow ${setting.flowId ?? "default"}: ${message}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "crunch scheduler tick failed";
    console.error(`Crunch scheduler tick error: ${message}`);
  } finally {
    crunchTickInFlight = false;
  }
}

// A background side-process the operator can schedule from the Crunch page. The
// registry is the single place to add new scheduled work: give it a key, copy,
// a default cron, and a handler, and it appears in the UI and the scheduler.
interface ScheduledTaskDefinition {
  key: string;
  label: string;
  description: string;
  defaultCron: string;
  run(): Promise<void>;
}

const scheduledTaskDefinitions: ScheduledTaskDefinition[] = [
  {
    key: "pull-request-refresh",
    label: "Pull request status refresh",
    description:
      "Checks open pull requests and advances proposals when they are merged (resolve gaps + re-index) " +
      "or closed (mark rejected) on the host. Requires GITHUB_TOKEN.",
    defaultCron: "*/10 * * * *",
    run: refreshPullRequests
  },
  {
    key: "gaps-to-pull-requests",
    label: "Clustered gaps → pull requests",
    description:
      "Clusters the open knowledge gaps, drafts a proposal for any cluster not already covered, then " +
      "publishes every draft and ready proposal as a pull request (auto-promoting drafts to ready). " +
      "A fully automated pipeline with no manual review step.",
    defaultCron: "0 * * * *",
    run: processGapsIntoPullRequests
  }
];

function findScheduledTask(key: string): ScheduledTaskDefinition | undefined {
  return scheduledTaskDefinitions.find((task) => task.key === key);
}

// The default (unsaved) schedule for a registered task, so the UI can render a
// control before the schedule has ever been saved.
function defaultScheduledTaskSettings(task: ScheduledTaskDefinition): ScheduledTaskSettings {
  return { key: task.key, enabled: false, cron: task.defaultCron };
}

let scheduledTaskTickInFlight = false;

// Drives every registered side-process on its own cron, mirroring the Crunch
// scheduler: one timer, a re-entrancy guard, and "reschedule before run" so a
// failure or restart can't cause a tight retry loop.
function startScheduledTaskScheduler(): void {
  const tickMs = Number.parseInt(process.env.SCHEDULED_TASK_TICK_MS ?? "60000", 10);
  const interval = Number.isFinite(tickMs) && tickMs > 0 ? tickMs : 60_000;
  const timer = setInterval(() => void scheduledTaskTick(), interval);
  timer.unref?.();
  console.log(`Scheduled task scheduler started (tick ${interval}ms)`);
}

async function scheduledTaskTick(): Promise<void> {
  if (scheduledTaskTickInFlight) {
    return;
  }
  scheduledTaskTickInFlight = true;
  try {
    const now = Date.now();
    for (const task of scheduledTaskDefinitions) {
      const setting = await scheduledTasks.getSettings(task.key);
      if (!setting?.enabled || !setting.nextRunAt) {
        continue;
      }
      if (new Date(setting.nextRunAt).getTime() > now) {
        continue;
      }

      const nextRunAt = nextCronTime(setting.cron, new Date(now));
      if (!nextRunAt) {
        console.warn(`Scheduled task ${task.key} has an invalid cron "${setting.cron}"; skipping.`);
        continue;
      }
      await scheduledTasks.touchSchedule(task.key, new Date(now).toISOString(), nextRunAt.toISOString());
      console.log(`Scheduled task ${task.key} due; running.`);
      try {
        await task.run();
      } catch (error) {
        const message = error instanceof Error ? error.message : "scheduled task run failed";
        console.error(`Scheduled task ${task.key} failed: ${message}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "scheduled task tick failed";
    console.error(`Scheduled task tick error: ${message}`);
  } finally {
    scheduledTaskTickInFlight = false;
  }
}

// For every proposal still awaiting its PR, ask the host whether it merged or
// closed and advance the proposal accordingly. No-ops gracefully when no
// GITHUB_TOKEN is configured (fetchPullRequestStatus returns undefined).
async function refreshPullRequests(): Promise<void> {
  const open = await proposals.list(200, { status: "pr-opened" });
  for (const proposal of open) {
    const pullRequestUrl = proposal.publication?.pullRequestUrl;
    if (!pullRequestUrl) {
      continue;
    }

    let status: Awaited<ReturnType<typeof fetchPullRequestStatus>>;
    try {
      status = await fetchPullRequestStatus(pullRequestUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : "pull request lookup failed";
      console.warn(`Pull request status check failed for proposal ${proposal.id}: ${message}`);
      continue;
    }
    if (!status) {
      continue;
    }

    if (status.merged) {
      const merged = await proposals.updateStatus(proposal.id, "merged");
      if (merged) {
        console.log(`Detected merged pull request for proposal ${proposal.id}; running merge cascade.`);
        await runMergeCascade(merged);
      }
    } else if (status.state === "closed") {
      // Closed without merging is effectively a rejection of the published
      // proposal; mark it so the task stops chasing a dead PR.
      await proposals.updateStatus(proposal.id, "rejected");
      console.log(`Pull request for proposal ${proposal.id} was closed without merging; marked rejected.`);
    }
  }
}

// The set of gap summaries that already have a proposal, so the gap-to-PR task
// never drafts the same gap twice. This deliberately includes rejected proposals
// (a closed PR): without it, an autonomous run would re-draft and re-raise every
// hour the very content a human just declined. Merged proposals resolve their
// gaps at the source, so those summaries stop appearing as candidates and need
// no entry here; proposals.list already omits merged rows.
async function coveredGapSummaries(): Promise<Set<string>> {
  const summaries = new Set<string>();
  for (const proposal of await proposals.list(500)) {
    for (const summary of splitGapSummaries(proposal.gapSummary)) {
      summaries.add(summary);
    }
  }
  return summaries;
}

// End-to-end gap-to-PR pipeline. First drafts proposals for any gap cluster not
// already covered, then auto-promotes every draft to ready and publishes all
// draft/ready proposals as pull requests. Each step is best-effort and logged so
// one failure can't abort the whole run.
async function processGapsIntoPullRequests(): Promise<void> {
  // 1) Cluster the open gaps and draft a proposal for each uncovered cluster.
  const candidates = await questionLogs.listGapCandidates(200);
  if (candidates.length > 0) {
    const clusters = await clusterGapCandidates(candidates);
    const toDraft = selectClustersToDraft(
      clusters,
      candidates.map((candidate) => candidate.summary),
      await coveredGapSummaries()
    );
    for (const summaries of toDraft) {
      try {
        const outcome = await draftProposalFromGapSummaries(summaries);
        if (!outcome.ok) {
          console.warn(`Gap-to-PR task skipped a cluster: ${outcome.code}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "draft failed";
        console.warn(`Gap-to-PR task failed to draft a cluster: ${message}`);
      }
    }
  }

  // 2) Get every unpublished proposal to a PR. Drafts are auto-promoted to ready
  // first; "branch-pushed" proposals are ones whose branch landed but whose PR
  // never opened (transient host error, or no token at the time), so we retry the
  // PR for them too. Raising a PR for a branch that already has one is rejected
  // by the host, so this can't create duplicates.
  const pending = [
    ...(await proposals.list(200, { status: "draft" })),
    ...(await proposals.list(200, { status: "ready" })),
    ...(await proposals.list(200, { status: "branch-pushed" }))
  ];
  for (const proposal of pending) {
    let candidate = proposal;
    if (candidate.status === "draft") {
      const promoted = await proposals.updateStatus(candidate.id, "ready");
      if (!promoted) {
        continue;
      }
      candidate = promoted;
    }

    try {
      const outcome = await publishReadyProposal(candidate);
      if (outcome.ok) {
        console.log(
          outcome.pullRequestUrl
            ? `Gap-to-PR task raised ${outcome.pullRequestUrl} for proposal ${candidate.id}.`
            : `Gap-to-PR task pushed a branch for proposal ${candidate.id} (no PR raised).`
        );
      } else {
        console.warn(`Gap-to-PR task could not publish proposal ${candidate.id}: ${outcome.code} (${outcome.message}).`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "publish failed";
      console.warn(`Gap-to-PR task failed to publish proposal ${candidate.id}: ${message}`);
    }
  }
}

// Always returns one row per registered task, merging in any saved schedule so
// the UI can render a control even before the schedule has been saved once.
async function scheduledTasksForResponse(): Promise<
  Array<{ key: string; label: string; description: string; settings: ScheduledTaskSettings }>
> {
  const stored = await scheduledTasks.listSettings();
  const byKey = new Map(stored.map((setting) => [setting.key, setting]));
  return scheduledTaskDefinitions.map((task) => ({
    key: task.key,
    label: task.label,
    description: task.description,
    settings: byKey.get(task.key) ?? defaultScheduledTaskSettings(task)
  }));
}

async function handleUpdateScheduledTaskSettings(
  key: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const task = findScheduledTask(key);
  if (!task) {
    writeJson(response, 404, { error: "scheduled_task_not_found" });
    return;
  }

  const payload = await readJsonBody<{ enabled?: boolean; cron?: string }>(request);
  const cron = typeof payload.cron === "string" ? payload.cron.trim() : "";
  if (!isValidCron(cron)) {
    writeJson(response, 400, {
      error: "valid_cron_required",
      message: "cron must be a standard 5-field expression, e.g. \"*/10 * * * *\"."
    });
    return;
  }

  await scheduledTasks.updateSettings(key, { enabled: Boolean(payload.enabled), cron });
  writeJson(response, 200, { tasks: await scheduledTasksForResponse() });
}

async function handleRunScheduledTask(key: string, response: ServerResponse): Promise<void> {
  const task = findScheduledTask(key);
  if (!task) {
    writeJson(response, 404, { error: "scheduled_task_not_found" });
    return;
  }

  try {
    await task.run();
    writeJson(response, 200, { ok: true, tasks: await scheduledTasksForResponse() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "scheduled task run failed";
    writeJson(response, 500, { error: "scheduled_task_run_failed", message });
  }
}

type AiProviderName = ChatProviderName | "codex" | "claude";

interface RuntimeAiConfig {
  aiExecutionMode: AiExecutionMode;
  aiProvider: AiProviderName;
}

function normalizeAiExecutionMode(value: string | undefined): AiExecutionMode | undefined {
  if (value === "direct" || value === "queue") {
    return value;
  }

  return undefined;
}

function normalizeAiProvider(value: string | undefined): AiProviderName | undefined {
  if (value === "mock" || value === "openai-compatible" || value === "azure-openai" || value === "codex" || value === "claude") {
    return value;
  }

  return undefined;
}

function createInitialRuntimeConfig(): RuntimeAiConfig {
  const aiExecutionMode = normalizeAiExecutionMode(process.env.AI_EXECUTION_MODE) ?? "direct";
  const providerFromEnv =
    process.env.AI_PROVIDER ??
    (aiExecutionMode === "queue" ? process.env.AI_JOB_PROVIDER : process.env.CHAT_PROVIDER) ??
    process.env.CHAT_PROVIDER ??
    process.env.AI_JOB_PROVIDER;
  const aiProvider = normalizeAiProvider(providerFromEnv) ?? "mock";
  const validationError = validateRuntimeAiConfig(aiExecutionMode, aiProvider);

  if (validationError) {
    throw new Error(validationError);
  }

  return {
    aiExecutionMode,
    aiProvider
  };
}

function validateRuntimeAiConfig(aiExecutionMode: AiExecutionMode, aiProvider: AiProviderName): string | undefined {
  const configuredProvider = getConfiguredAiProviders().find((provider) => provider.name === aiProvider);
  if (!configuredProvider) {
    return `${aiProvider} is not configured by environment variables`;
  }

  if (aiExecutionMode === "direct" && !configuredProvider.supportsDirect) {
    return `${aiProvider} cannot be used in direct mode`;
  }

  if (aiExecutionMode === "queue" && !configuredProvider.supportsQueue) {
    return `${aiProvider} cannot be used in queue mode`;
  }

  return undefined;
}

function getConfiguredAiProviders(): Array<{
  name: AiProviderName;
  label: string;
  supportsDirect: boolean;
  supportsQueue: boolean;
}> {
  const providers: Array<{
    name: AiProviderName;
    label: string;
    supportsDirect: boolean;
    supportsQueue: boolean;
  }> = [
    {
      name: "mock",
      label: "Mock",
      supportsDirect: true,
      supportsQueue: true
    }
  ];

  if (process.env.OPENAI_COMPATIBLE_BASE_URL && process.env.OPENAI_COMPATIBLE_API_KEY && process.env.OPENAI_COMPATIBLE_MODEL) {
    providers.push({
      name: "openai-compatible",
      label: "OpenAI-compatible",
      supportsDirect: true,
      supportsQueue: true
    });
  }

  if (process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_CHAT_DEPLOYMENT) {
    providers.push({
      name: "azure-openai",
      label: "Azure OpenAI",
      supportsDirect: true,
      supportsQueue: false
    });
  }

  if (process.env.CODEX_CLI_PATH || process.env.AI_PROVIDER === "codex" || process.env.AI_JOB_PROVIDER === "codex") {
    providers.push({
      name: "codex",
      label: "Codex CLI",
      supportsDirect: false,
      supportsQueue: true
    });
  }

  if (process.env.CLAUDE_CLI_PATH || process.env.AI_PROVIDER === "claude" || process.env.AI_JOB_PROVIDER === "claude") {
    providers.push({
      name: "claude",
      label: "Claude CLI",
      supportsDirect: false,
      supportsQueue: true
    });
  }

  return providers;
}

function createAiJobQueue(): InMemoryAiJobQueue | PostgresAiJobQueue {
  if (storeBackend("AI_JOB_QUEUE") === "postgres") {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required when AI_JOB_QUEUE=postgres");
    }

    return new PostgresAiJobQueue(databaseUrl, aiJobClaimTimeoutMs);
  }

  return new InMemoryAiJobQueue(aiJobClaimTimeoutMs);
}

function parseClaimTimeoutMs(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_AI_JOB_CLAIM_TIMEOUT_MS;
  }

  return parsed;
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required when KNOWLEDGE_STORE=postgres");
  }
  return databaseUrl;
}

// Embeddings can target a different endpoint/key than chat (e.g. DeepSeek for
// Q&A, OpenAI for embeddings). The dedicated OPENAI_COMPATIBLE_EMBEDDING_* vars
// take precedence, falling back to the shared chat credentials when unset so
// single-endpoint setups keep working unchanged.
function embeddingBaseUrl(): string | undefined {
  return process.env.OPENAI_COMPATIBLE_EMBEDDING_BASE_URL || process.env.OPENAI_COMPATIBLE_BASE_URL || undefined;
}

function embeddingApiKey(): string | undefined {
  return process.env.OPENAI_COMPATIBLE_EMBEDDING_API_KEY || process.env.OPENAI_COMPATIBLE_API_KEY || undefined;
}

function embeddingProviderName(): EmbeddingProviderName | undefined {
  if (embeddingBaseUrl() && embeddingApiKey() && process.env.OPENAI_COMPATIBLE_EMBEDDING_MODEL) {
    return "openai-compatible";
  }
  if (process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT) {
    return "azure-openai";
  }
  return undefined;
}

function createConfiguredEmbeddingProvider() {
  const provider = embeddingProviderName();
  if (!provider) {
    return undefined;
  }
  return createEmbeddingProvider({
    provider,
    apiKey: embeddingApiKey() || process.env.AZURE_OPENAI_API_KEY,
    baseUrl: embeddingBaseUrl(),
    model: process.env.OPENAI_COMPATIBLE_EMBEDDING_MODEL,
    azureEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
    azureDeployment: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
    azureApiVersion: process.env.AZURE_OPENAI_API_VERSION
  });
}

function retrievalMode(): { mode: "hybrid" | "keyword"; reason: string } {
  const hasEmbeddings = embeddingProviderName() !== undefined;
  const postgres = storeBackend("KNOWLEDGE_STORE") === "postgres";
  if (hasEmbeddings && postgres) {
    return { mode: "hybrid", reason: "Semantic + keyword search active." };
  }
  if (!hasEmbeddings) {
    return { mode: "keyword", reason: "Add an embeddings endpoint to enable semantic search." };
  }
  return { mode: "keyword", reason: "Semantic search requires the Postgres knowledge store (KNOWLEDGE_STORE=postgres)." };
}

let embeddingInFlight = false;
let embeddingRerunRequested = false;

async function embedSectionsInBackground(): Promise<void> {
  if (!knowledgeStore || !embeddingProvider) {
    return;
  }
  if (embeddingInFlight) {
    embeddingRerunRequested = true;
    return;
  }
  embeddingInFlight = true;
  try {
    do {
      embeddingRerunRequested = false;
      const result = await embedPendingSections({ store: knowledgeStore, provider: embeddingProvider });
      if (result.embeddedCount > 0) {
        console.log(`Embedded ${result.embeddedCount} section(s); ${result.remaining} remaining`);
      }
    } while (embeddingRerunRequested);
  } catch (error) {
    console.warn(`Background embedding failed: ${error instanceof Error ? error.message : "unknown error"}`);
  } finally {
    embeddingInFlight = false;
  }
}

function createQuestionLogStore(): InMemoryQuestionLogStore | PostgresQuestionLogStore {
  if (storeBackend("QUESTION_LOG_STORE") === "postgres") {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required when QUESTION_LOG_STORE=postgres");
    }

    return new PostgresQuestionLogStore(databaseUrl);
  }

  return new InMemoryQuestionLogStore();
}

function createProposalStore(): InMemoryProposalStore | PostgresProposalStore {
  if (storeBackend("PROPOSAL_STORE") === "postgres") {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required when PROPOSAL_STORE=postgres");
    }

    return new PostgresProposalStore(databaseUrl);
  }

  return new InMemoryProposalStore();
}

function storageBackend(): "memory" | "postgres" {
  return process.env.STORAGE_BACKEND === "postgres" ? "postgres" : "memory";
}

function storeBackend(
  name:
    | "KNOWLEDGE_STORE"
    | "QUESTION_LOG_STORE"
    | "PROPOSAL_STORE"
    | "AI_JOB_QUEUE"
    | "CRUNCH_STORE"
    | "SCHEDULED_TASK_STORE"
): "memory" | "postgres" {
  return process.env[name] === "postgres" ? "postgres" : storageBackend();
}

function createCrunchStore(): InMemoryCrunchStore | PostgresCrunchStore {
  if (storeBackend("CRUNCH_STORE") === "postgres") {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required when CRUNCH_STORE=postgres");
    }

    return new PostgresCrunchStore(databaseUrl);
  }

  return new InMemoryCrunchStore();
}

function createScheduledTaskStore(): InMemoryScheduledTaskStore | PostgresScheduledTaskStore {
  if (storeBackend("SCHEDULED_TASK_STORE") === "postgres") {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required when SCHEDULED_TASK_STORE=postgres");
    }

    return new PostgresScheduledTaskStore(databaseUrl);
  }

  return new InMemoryScheduledTaskStore();
}

function createConfiguredChatProvider(provider: AiProviderName) {
  if (provider !== "mock" && provider !== "openai-compatible" && provider !== "azure-openai") {
    throw new Error(`${provider} cannot be used as a direct chat provider`);
  }

  return createChatProvider({
    provider,
    apiKey: process.env.OPENAI_COMPATIBLE_API_KEY || process.env.AZURE_OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL,
    model: process.env.OPENAI_COMPATIBLE_MODEL,
    azureEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
    azureDeployment: process.env.AZURE_OPENAI_CHAT_DEPLOYMENT,
    azureApiVersion: process.env.AZURE_OPENAI_API_VERSION
  });
}

function isAiJobType(value: unknown): value is AiJobType {
  return (
    value === "answer_question" ||
    value === "summarize_gap" ||
    value === "draft_markdown_proposal" ||
    value === "detect_contradiction" ||
    value === "suggest_consolidation" ||
    value === "crunch_knowledge_base"
  );
}

function isAnswerQuestionJobOutput(value: unknown): value is AnswerQuestionJobOutput {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<AnswerQuestionJobOutput>;
  return (
    typeof candidate.answer === "string" &&
    (candidate.confidence === "high" ||
      candidate.confidence === "medium" ||
      candidate.confidence === "low" ||
      candidate.confidence === "unknown") &&
    Array.isArray(candidate.citations)
  );
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

function isQuestionFeedback(value: unknown): value is QuestionFeedback {
  return value === "helpful" || value === "unhelpful";
}

function isProposalStatus(value: unknown): value is Proposal["status"] {
  return (
    value === "draft" ||
    value === "ready" ||
    value === "branch-pushed" ||
    value === "pr-opened" ||
    value === "merged" ||
    value === "rejected"
  );
}

async function findRepositoryForProposal(proposal: Proposal): Promise<RepositoryRef | undefined> {
  if (configuredKnowledgeDestinations.length > 0) {
    const destination = selectDestinationForProposal(proposal);
    if (!destination) {
      return undefined;
    }

    const localPath = await resolveConfiguredRepositoryLocalPath(destination);
    const summary = await knowledgeIndex.indexLocalRepository({
      localPath,
      repositoryId: destination.id,
      name: destination.name
    });
    void embedSectionsInBackground();
    return summary.repository;
  }

  const targetPath = normalizeRelativePath(proposal.targetPath);
  const repositories = knowledgeIndex.listRepositories();
  const explicitMatch = repositories
    .map((repository) => ({
      repository,
      relativePathFromRoot: normalizeRelativePath(repository.git?.relativePathFromRoot)
    }))
    .filter(({ relativePathFromRoot }) => relativePathFromRoot && relativePathFromRoot !== ".")
    .sort((left, right) => right.relativePathFromRoot.length - left.relativePathFromRoot.length)
    .find(
      ({ relativePathFromRoot }) => targetPath === relativePathFromRoot || targetPath.startsWith(`${relativePathFromRoot}/`)
    );

  return explicitMatch?.repository ?? (repositories.length === 1 ? repositories[0] : repositories.find((repository) => normalizeRelativePath(repository.git?.relativePathFromRoot) === "."));
}

function destinationSubpath(destinationId: string | undefined): string | undefined {
  if (!destinationId) {
    return undefined;
  }
  return configuredKnowledgeDestinations.find((destination) => destination.id === destinationId)?.subpath;
}

function selectDestinationForProposal(proposal: Proposal): ConfiguredKnowledgeRepository | undefined {
  if (proposal.destinationId) {
    return configuredKnowledgeDestinations.find((destination) => destination.id === proposal.destinationId);
  }

  const targetPath = normalizeRelativePath(proposal.targetPath);
  const explicitMatch = configuredKnowledgeDestinations
    .filter((destination) => destination.subpath)
    .sort((left, right) => (right.subpath ?? "").length - (left.subpath ?? "").length)
    .find((destination) => {
      const subpath = normalizeRelativePath(destination.subpath);
      return targetPath === subpath || targetPath.startsWith(`${subpath}/`);
    });

  return explicitMatch ?? (configuredKnowledgeDestinations.length === 1 ? configuredKnowledgeDestinations[0] : undefined);
}

async function syncConfiguredGitCheckouts(): Promise<void> {
  const gitRepositories = uniqueConfiguredGitRepositories([
    ...configuredKnowledgeSources,
    ...configuredKnowledgeDestinations
  ]);

  const checkoutKey = (repository: ConfiguredKnowledgeRepository) => `${repository.id}\0${repository.url ?? ""}`;
  const sourceKeys = new Set(configuredKnowledgeSources.filter((source) => source.kind === "git").map(checkoutKey));

  console.log(`Syncing ${gitRepositories.length} configured git checkout(s)`);
  for (const repository of gitRepositories) {
    const localPath = await resolveConfiguredRepositoryLocalPath(repository);
    if (existsSync(localPath)) {
      console.log(`Synced configured git ${repository.id} at ${localPath}`);
      continue;
    }

    const subpathHint = repository.subpath
      ? ` Configured subpath "${repository.subpath}" was not found in the cloned repository.`
      : "";
    if (sourceKeys.has(checkoutKey(repository))) {
      // A read source with a missing path is a real misconfiguration: drafts
      // built from it will have no real material to work with.
      console.warn(
        `Synced configured git source ${repository.id}, but resolved path ${localPath} does not exist.${subpathHint} ` +
          "Drafts from this source will have no real material until the configuration is corrected."
      );
    } else {
      // A destination's subpath legitimately may not exist yet, but publishing
      // indexes it first (git-context detection + markdown scan), which fails
      // on a missing directory. Create the empty folder inside the checkout so
      // the first publish has somewhere to write. (Empty dirs aren't tracked by
      // git; the file itself is committed on publish.)
      try {
        await mkdir(localPath, { recursive: true });
        console.log(
          `Created empty destination folder for ${repository.id} at ${localPath}.${subpathHint} ` +
            "This is expected for a fresh destination; it will be populated when proposals are published."
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        console.warn(`Could not create destination folder for ${repository.id} at ${localPath}: ${message}`);
      }
    }
  }
}

function uniqueConfiguredGitRepositories(repositories: ConfiguredKnowledgeRepository[]): ConfiguredKnowledgeRepository[] {
  const byCheckout = new Map<string, ConfiguredKnowledgeRepository>();

  for (const repository of repositories) {
    if (repository.kind !== "git") {
      continue;
    }

    byCheckout.set(`${repository.id}\0${repository.url ?? ""}`, repository);
  }

  return [...byCheckout.values()];
}

async function resolveConfiguredRepositoryLocalPath(repository: ConfiguredKnowledgeRepository): Promise<string> {
  if (repository.kind === "internet" || repository.kind === "agent") {
    throw new Error(`${repository.kind}_sources_cannot_be_checked_out`);
  }

  let localPath: string;
  if (repository.kind === "git") {
    if (!repository.url) {
      throw new Error("configured_git_repository_url_required");
    }
    const checkout = await ensureGitCheckout({
      id: repository.id,
      url: repository.url,
      branch: repository.branch,
      checkoutRoot: checkoutRoot()
    });
    localPath = checkout.localPath;
  } else if (repository.path) {
    localPath = resolveLocalConfiguredPath(repository.path);
  } else {
    throw new Error("configured_local_repository_path_required");
  }

  return repository.subpath ? path.join(localPath, repository.subpath) : localPath;
}

function checkoutRoot(): string {
  return resolveLocalConfiguredPath(process.env.MAGPIE_CHECKOUT_ROOT ?? ".magpie/checkouts");
}

function resolveLocalConfiguredPath(value: string): string {
  if (path.isAbsolute(value)) {
    return value;
  }

  return path.resolve(process.env.INIT_CWD ?? process.cwd(), value);
}

function defaultDestinationId(): string | undefined {
  return configuredKnowledgeDestinations.length === 1 ? configuredKnowledgeDestinations[0].id : undefined;
}

function selectFlow(flowId: string | undefined): ConfiguredKnowledgeFlow | undefined {
  const trimmed = flowId?.trim();
  if (trimmed) {
    return configuredKnowledgeFlows.find((flow) => flow.id === trimmed);
  }

  return configuredKnowledgeFlows.length === 1 ? configuredKnowledgeFlows[0] : undefined;
}

async function collectSourceContext(sourceIds: string[] | undefined): Promise<SourceDataContext[]> {
  const selectedSources = selectSources(sourceIds);
  console.log(
    `Collecting source context from ${selectedSources.length} source(s): ` +
      (selectedSources.map((source) => `${source.id}(${source.kind})`).join(", ") || "none")
  );
  if (sourceIds?.length && selectedSources.length === 0) {
    console.warn(
      `Requested source ids [${sourceIds.join(", ")}] matched no configured sources. Check KNOWLEDGE_SOURCES.`
    );
  }
  const contexts: SourceDataContext[] = [];

  for (const source of selectedSources) {
    if (source.kind === "internet") {
      contexts.push({
        sourceId: source.id,
        sourceName: source.name,
        kind: source.kind,
        url: source.url,
        content: source.url
          ? "Use this internet source as supporting raw material."
          : "Use relevant internet research as supporting raw material."
      });
      console.log(`Source ${source.id}: internet reference${source.url ? ` (${source.url})` : ""}; content is not fetched.`);
      continue;
    }

    if (source.kind === "agent") {
      contexts.push({
        sourceId: source.id,
        sourceName: source.name,
        kind: source.kind,
        content: "Use general agent knowledge as supporting raw material where no configured repository or URL is available."
      });
      console.log(`Source ${source.id}: agent knowledge reference; no repository content attached.`);
      continue;
    }

    try {
      const localPath = await resolveConfiguredRepositoryLocalPath(source);
      const localContexts = await collectLocalSourceContext(source, localPath);
      contexts.push(...localContexts);
      const fileContexts = localContexts.filter((context) => context.path);
      const totalBytes = fileContexts.reduce((sum, context) => sum + (context.content?.length ?? 0), 0);
      if (fileContexts.length === 0) {
        console.warn(
          `Source ${source.id}: no usable files collected from ${localPath}` +
            (source.subpath ? ` (subpath "${source.subpath}")` : "") +
            ". Drafts from this source will have no real material."
        );
      } else {
        console.log(`Source ${source.id}: collected ${fileContexts.length} file(s), ${totalBytes} bytes from ${localPath}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "unavailable source";
      console.error(`Source ${source.id}: failed to collect context — ${message}`);
      contexts.push({
        sourceId: source.id,
        sourceName: source.name,
        kind: source.kind,
        path: source.path,
        url: source.url,
        content: `Source unavailable: ${message}`
      });
    }
  }

  return contexts;
}

function selectSources(sourceIds: string[] | undefined): ConfiguredKnowledgeRepository[] {
  if (configuredKnowledgeSources.length === 0) {
    return [];
  }

  const requested = new Set((sourceIds ?? []).map((id) => id.trim()).filter(Boolean));
  if (requested.size === 0) {
    return configuredKnowledgeSources.slice(0, 3);
  }

  return configuredKnowledgeSources.filter((source) => requested.has(source.id));
}

async function collectLocalSourceContext(
  source: ConfiguredKnowledgeRepository,
  root: string
): Promise<SourceDataContext[]> {
  if (!existsSync(root)) {
    console.warn(
      `Source ${source.id}: path ${root} does not exist` +
        (source.subpath ? ` — configured subpath "${source.subpath}" is missing from the repository.` : ".")
    );
    return [
      {
        sourceId: source.id,
        sourceName: source.name,
        kind: source.kind,
        path: root,
        url: source.url,
        content: "Source path does not exist."
      }
    ];
  }

  const files = await findSourceContextFiles(root);
  console.log(`Source ${source.id}: found ${files.length} candidate text file(s) under ${root}`);
  const contexts: SourceDataContext[] = [];
  let remainingBytes = 80_000;

  for (const file of files.slice(0, 24)) {
    if (remainingBytes <= 0) {
      break;
    }
    const content = await readFile(file, "utf8");
    const excerpt = content.slice(0, Math.min(content.length, remainingBytes, 8_000));
    remainingBytes -= excerpt.length;
    contexts.push({
      sourceId: source.id,
      sourceName: source.name,
      kind: source.kind,
      path: toPosixPath(path.relative(root, file)),
      url: source.url,
      content: excerpt
    });
  }

  return contexts;
}

async function findSourceContextFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walkSourceFiles(root, files);
  return files.sort((left, right) => sourceFilePriority(left) - sourceFilePriority(right) || left.localeCompare(right));
}

async function walkSourceFiles(root: string, files: string[]): Promise<void> {
  const entries = await readdir(root);
  for (const entry of entries) {
    if (ignoredSourceEntry(entry)) {
      continue;
    }

    const fullPath = path.join(root, entry);
    const entryStat = await stat(fullPath);
    if (entryStat.isDirectory()) {
      await walkSourceFiles(fullPath, files);
      continue;
    }

    if (entryStat.isFile() && entryStat.size <= 250_000 && isTextSourceFile(entry)) {
      files.push(fullPath);
    }
  }
}

function ignoredSourceEntry(entry: string): boolean {
  return new Set([".git", "node_modules", "dist", "build", ".next", "coverage", "vendor", ".turbo"]).has(entry);
}

function isTextSourceFile(entry: string): boolean {
  return /\.(?:md|mdx|txt|ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|toml|py|go|rs|cs|java|kt|swift|php|rb|css|scss|html)$/i.test(entry);
}

function sourceFilePriority(file: string): number {
  const basename = path.basename(file).toLowerCase();
  if (/^readme(?:\..+)?$/.test(basename)) {
    return 0;
  }
  if (["package.json", "pyproject.toml", "cargo.toml", "go.mod"].includes(basename)) {
    return 1;
  }
  if (/\.(?:md|mdx)$/i.test(basename)) {
    return 2;
  }
  return 3;
}

function createProposalBranchName(proposal: Proposal): string {
  return `magpie/proposal-${proposal.id.slice(0, 8)}-${slugify(proposal.title).slice(0, 40)}`;
}

function apiRoutePath(pathname: string): string | undefined {
  if (pathname === "/api") {
    return "/";
  }

  if (pathname.startsWith("/api/")) {
    return pathname.slice("/api".length);
  }

  return undefined;
}

