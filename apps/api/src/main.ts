import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type {
  AiJobType,
  Proposal,
  QuestionFeedback,
  ScheduledTaskSettings
} from "@magpie/core";
import { isValidCron, nextCronTime } from "@magpie/core";
import { fetchPullRequestStatus } from "@magpie/git";
import { selectClustersToDraft } from "./stores/gap-clustering.js";
import { apiLink, parseLimit } from "./platform/paths.js";
import { normalizeAiExecutionMode, normalizeAiProvider } from "./config-holder.js";
import { type AppContext, createAppContext } from "./context.js";
import * as questionsService from "./features/questions/service.js";
import * as gapsService from "./features/gaps/service.js";
import * as askService from "./features/ask/service.js";
import * as knowledgeService from "./features/knowledge/service.js";
import { knowledgeRepositoryErrorCode } from "./features/knowledge/service.js";
import * as proposalsService from "./features/proposals/service.js";
import * as crunchService from "./features/crunch/service.js";
import * as jobsService from "./features/jobs/service.js";
import * as configService from "./features/config/service.js";

const port = Number.parseInt(process.env.PORT ?? "4000", 10);

async function start(): Promise<void> {
  const ctx = await createAppContext();

  const server = createServer(async (request, response) => {
    try {
      await route(ctx, request, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      writeJson(response, 500, { error: "internal_error", message });
    }
  });

  try {
    await ctx.bootstrap();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`Failed to sync configured git repositories: ${message}`);
    process.exitCode = 1;
    return;
  }

  server.listen(port, () => {
    console.log(`Markdown Magpie API listening on http://localhost:${port}/api`);
    configService.logStartupConfig(ctx);
    startCrunchScheduler(ctx);
    startScheduledTaskScheduler(ctx);
  });
}

void start();

async function route(ctx: AppContext, request: IncomingMessage, response: ServerResponse): Promise<void> {
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
    writeJson(response, 200, configService.getRuntimeConfig(ctx));
    return;
  }

  if (request.method === "POST" && path === "/config") {
    await handleUpdateRuntimeConfig(ctx, request, response);
    return;
  }

  if (request.method === "POST" && path === "/admin/reset") {
    await handleResetData(ctx, response);
    return;
  }

  if (request.method === "POST" && path === "/ask") {
    await handleAsk(ctx, request, response);
    return;
  }

  if (request.method === "POST" && path === "/repositories/index") {
    await handleIndexRepository(ctx, request, response);
    return;
  }

  if (request.method === "GET" && path === "/repositories") {
    writeJson(response, 200, { repositories: knowledgeService.listRepositories(ctx) });
    return;
  }

  if (request.method === "POST" && path === "/documents/upload") {
    await handleUploadDocuments(ctx, request, response);
    return;
  }

  if (request.method === "GET" && path === "/documents") {
    writeJson(response, 200, { documents: knowledgeService.listDocuments(ctx) });
    return;
  }

  if (request.method === "GET" && path === "/knowledge/stats") {
    writeJson(response, 200, knowledgeService.stats(ctx));
    return;
  }

  if (request.method === "GET" && path === "/search") {
    const query = url.searchParams.get("q")?.trim();
    if (!query) {
      writeJson(response, 400, { error: "query_required" });
      return;
    }

    const ranked = await knowledgeService.search(ctx, query, parseLimit(url.searchParams.get("limit"), 5));
    writeJson(response, 200, { sections: ranked.map((result) => result.section), ranked });
    return;
  }

  if (request.method === "GET" && path === "/questions") {
    const limit = parseLimit(url.searchParams.get("limit"), 50);
    writeJson(response, 200, { questions: await questionsService.listQuestions(ctx, limit) });
    return;
  }

  const questionMatch = /^\/questions\/([^/]+)$/.exec(path);
  if (request.method === "GET" && questionMatch) {
    const log = await questionsService.getQuestion(ctx, questionMatch[1]);
    if (!log) {
      writeJson(response, 404, { error: "question_not_found" });
      return;
    }

    writeJson(response, 200, { question: log });
    return;
  }

  const feedbackMatch = /^\/questions\/([^/]+)\/feedback$/.exec(path);
  if (request.method === "POST" && feedbackMatch) {
    await handleQuestionFeedback(ctx, feedbackMatch[1], request, response);
    return;
  }

  const gapMatch = /^\/questions\/([^/]+)\/gap$/.exec(path);
  if (request.method === "POST" && gapMatch) {
    await handleRecordManualGap(ctx, gapMatch[1], request, response);
    return;
  }

  if (request.method === "DELETE" && gapMatch) {
    await handleClearManualGap(ctx, gapMatch[1], response);
    return;
  }

  if (request.method === "GET" && path === "/gaps/candidates") {
    const limit = parseLimit(url.searchParams.get("limit"), 50);
    writeJson(response, 200, { gaps: await gapsService.listCandidates(ctx, limit) });
    return;
  }

  if (request.method === "GET" && path === "/gaps/clusters") {
    const limit = parseLimit(url.searchParams.get("limit"), 50);
    const clusters = await gapsService.listClusters(ctx, limit);
    writeJson(response, 200, { clusters });
    return;
  }

  if (request.method === "GET" && path === "/proposals") {
    const limit = parseLimit(url.searchParams.get("limit"), 50);
    const statusFilter = url.searchParams.get("status");
    const options = proposalsService.isProposalStatus(statusFilter) ? { status: statusFilter } : undefined;
    writeJson(response, 200, { proposals: await proposalsService.list(ctx, limit, options) });
    return;
  }

  if (request.method === "POST" && (path === "/proposals/from-gap" || path === "/proposals/from-gaps")) {
    await handleCreateProposalFromGaps(ctx, request, response);
    return;
  }

  const proposalMatch = /^\/proposals\/([^/]+)$/.exec(path);
  if (request.method === "GET" && proposalMatch) {
    const proposal = await proposalsService.get(ctx, proposalMatch[1]);
    if (!proposal) {
      writeJson(response, 404, { error: "proposal_not_found" });
      return;
    }

    writeJson(response, 200, { proposal });
    return;
  }

  const proposalStatusMatch = /^\/proposals\/([^/]+)\/status$/.exec(path);
  if (request.method === "POST" && proposalStatusMatch) {
    await handleUpdateProposalStatus(ctx, proposalStatusMatch[1], request, response);
    return;
  }

  const proposalPublishMatch = /^\/proposals\/([^/]+)\/publish$/.exec(path);
  if (request.method === "POST" && proposalPublishMatch) {
    await handlePublishProposal(ctx, proposalPublishMatch[1], response);
    return;
  }

  if (request.method === "GET" && path === "/crunch/runs") {
    const limit = parseLimit(url.searchParams.get("limit"), 20);
    writeJson(response, 200, { runs: await crunchService.listRuns(ctx, limit) });
    return;
  }

  if (request.method === "POST" && path === "/crunch/run") {
    await handleTriggerCrunch(ctx, request, response);
    return;
  }

  if (request.method === "GET" && path === "/crunch/settings") {
    writeJson(response, 200, { settings: await crunchService.settingsForResponse(ctx) });
    return;
  }

  if (request.method === "POST" && path === "/crunch/settings") {
    await handleUpdateCrunchSettings(ctx, request, response);
    return;
  }

  const crunchRunPublishMatch = /^\/crunch\/runs\/([^/]+)\/publish$/.exec(path);
  if (request.method === "POST" && crunchRunPublishMatch) {
    await handlePublishCrunchRun(ctx, crunchRunPublishMatch[1], response);
    return;
  }

  if (request.method === "GET" && path === "/scheduled-tasks") {
    writeJson(response, 200, { tasks: await scheduledTasksForResponse(ctx) });
    return;
  }

  const scheduledTaskSettingsMatch = /^\/scheduled-tasks\/([^/]+)\/settings$/.exec(path);
  if (request.method === "POST" && scheduledTaskSettingsMatch) {
    await handleUpdateScheduledTaskSettings(ctx, scheduledTaskSettingsMatch[1], request, response);
    return;
  }

  const scheduledTaskRunMatch = /^\/scheduled-tasks\/([^/]+)\/run$/.exec(path);
  if (request.method === "POST" && scheduledTaskRunMatch) {
    await handleRunScheduledTask(ctx, scheduledTaskRunMatch[1], response);
    return;
  }

  const crunchRunMatch = /^\/crunch\/runs\/([^/]+)$/.exec(path);
  if (request.method === "GET" && crunchRunMatch) {
    const run = await crunchService.getRun(ctx, crunchRunMatch[1]);
    if (!run) {
      writeJson(response, 404, { error: "crunch_run_not_found" });
      return;
    }
    writeJson(response, 200, { run });
    return;
  }

  if (request.method === "POST" && path === "/ai-jobs") {
    await handleCreateJob(ctx, request, response);
    return;
  }

  if (request.method === "GET" && path === "/ai-jobs") {
    writeJson(response, 200, { jobs: await jobsService.listJobs(ctx) });
    return;
  }

  if (request.method === "POST" && path === "/ai-jobs/claim") {
    await handleClaimJob(ctx, request, response);
    return;
  }

  const completeMatch = /^\/ai-jobs\/([^/]+)\/complete$/.exec(path);
  if (request.method === "POST" && completeMatch) {
    await handleCompleteJob(ctx, completeMatch[1], request, response);
    return;
  }

  const failMatch = /^\/ai-jobs\/([^/]+)\/fail$/.exec(path);
  if (request.method === "POST" && failMatch) {
    await handleFailJob(ctx, failMatch[1], request, response);
    return;
  }

  const getMatch = /^\/ai-jobs\/([^/]+)$/.exec(path);
  if (request.method === "GET" && getMatch) {
    const job = await jobsService.getJob(ctx, getMatch[1]);
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
  ctx: AppContext,
  proposalId: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const payload = await readJsonBody<{ status?: Proposal["status"] }>(request);

  if (!proposalsService.isProposalStatus(payload.status)) {
    writeJson(response, 400, { error: "valid_proposal_status_required" });
    return;
  }

  const proposal = await proposalsService.updateStatus(ctx, proposalId, payload.status);
  if (!proposal) {
    writeJson(response, 404, { error: "proposal_not_found" });
    return;
  }

  // Merging is the point at which the proposal's content lands in the knowledge
  // base: resolve the gaps it closed so they stop surfacing, then re-index the
  // destination so the new doc becomes searchable.
  if (proposal.status === "merged") {
    const { resolvedGapCount, reindexed } = await proposalsService.runMergeCascade(ctx, proposal);
    writeJson(response, 200, { proposal, resolvedGapCount, reindexed });
    return;
  }

  writeJson(response, 200, { proposal });
}

async function handlePublishProposal(
  ctx: AppContext,
  proposalId: string,
  response: ServerResponse
): Promise<void> {
  const proposal = await proposalsService.get(ctx, proposalId);
  if (!proposal) {
    writeJson(response, 404, { error: "proposal_not_found" });
    return;
  }

  if (proposal.status !== "ready") {
    writeJson(response, 409, { error: "proposal_not_ready", message: "Only ready proposals can be published." });
    return;
  }

  const outcome = await proposalsService.publishReadyProposal(ctx, proposal);
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

async function handleUpdateRuntimeConfig(
  ctx: AppContext,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
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

  const error = ctx.config.update({ aiExecutionMode: nextExecutionMode, aiProvider: nextProvider });
  if (error) {
    writeJson(response, 400, { error: "unsupported_ai_runtime_config", message: error });
    return;
  }

  writeJson(response, 200, configService.getRuntimeConfig(ctx));
}

async function handleResetData(ctx: AppContext, response: ServerResponse): Promise<void> {
  const { reindexed, failures, stats } = await configService.resetData(ctx);

  writeJson(response, 200, {
    ok: true,
    reindexed,
    failures,
    stats
  });
}

async function handleCreateProposalFromGaps(
  ctx: AppContext,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const payload = await readJsonBody<{
    summary?: string;
    summaries?: string[];
    targetPath?: string;
    flowId?: string;
    sourceIds?: string[];
    destinationId?: string;
  }>(request);

  const requested = [...(payload.summaries ?? []), ...(payload.summary ? [payload.summary] : [])];
  const outcome = await proposalsService.draftFromGaps(ctx, requested, {
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

async function handleQuestionFeedback(
  ctx: AppContext,
  questionId: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const payload = await readJsonBody<{ feedback?: QuestionFeedback }>(request);

  if (!questionsService.isQuestionFeedback(payload.feedback)) {
    writeJson(response, 400, { error: "valid_feedback_required" });
    return;
  }

  const question = await questionsService.recordFeedback(ctx, questionId, payload.feedback);
  if (!question) {
    writeJson(response, 404, { error: "question_not_found" });
    return;
  }

  writeJson(response, 200, { question });
}

async function handleRecordManualGap(
  ctx: AppContext,
  questionId: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const payload = await readJsonBody<{ summary?: string }>(request);
  const summary = typeof payload.summary === "string" ? payload.summary : undefined;

  const question = await questionsService.recordManualGap(ctx, questionId, summary);
  if (!question) {
    writeJson(response, 404, { error: "question_not_found" });
    return;
  }

  writeJson(response, 200, { question });
}

async function handleClearManualGap(
  ctx: AppContext,
  questionId: string,
  response: ServerResponse
): Promise<void> {
  const question = await questionsService.clearManualGap(ctx, questionId);
  if (!question) {
    writeJson(response, 404, { error: "question_not_found" });
    return;
  }

  writeJson(response, 200, { question });
}

async function handleAsk(ctx: AppContext, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const payload = await readJsonBody<{ question?: string }>(request);
  const question = payload.question?.trim();

  if (!question) {
    writeJson(response, 400, { error: "question_required" });
    return;
  }

  const outcome = await askService.ask(ctx, question);
  if (outcome.kind === "queue") {
    writeJson(response, 202, {
      mode: "queue",
      questionId: outcome.questionId,
      job: outcome.job,
      links: {
        question: apiLink(`/questions/${outcome.questionId}`),
        status: apiLink(`/ai-jobs/${outcome.job.id}`)
      }
    });
    return;
  }

  writeJson(response, 200, {
    mode: outcome.mode,
    questionId: outcome.questionId,
    result: outcome.result
  });
}

async function handleIndexRepository(
  ctx: AppContext,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const payload = await readJsonBody<{ flowId?: string; localPath?: string; repositoryId?: string; name?: string }>(request);

  let selection: { localPath: string; repositoryId?: string; name?: string };
  try {
    selection = await knowledgeService.resolveSelection(ctx, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "configured_repository_required";
    writeJson(response, 400, { error: knowledgeRepositoryErrorCode(message), message });
    return;
  }

  const summary = await knowledgeService.indexSelection(ctx, selection);
  writeJson(response, 200, summary);
}

async function handleUploadDocuments(
  ctx: AppContext,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const payload = await readJsonBody<{
    repositoryId?: string;
    name?: string;
    documents?: Array<{ path?: string; content?: string }>;
  }>(request);
  const documents = knowledgeService.normalizeUploadDocuments(payload.documents);

  if (documents.length === 0) {
    writeJson(response, 400, { error: "markdown_documents_required" });
    return;
  }

  if (documents.some((document) => document.content.length > 250_000)) {
    writeJson(response, 413, { error: "markdown_document_too_large" });
    return;
  }

  const summary = await knowledgeService.uploadDocuments(ctx, {
    repositoryId: payload.repositoryId,
    name: payload.name,
    documents
  });

  writeJson(response, 201, summary);
}

async function handleCreateJob(ctx: AppContext, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const payload = await readJsonBody<{ type?: AiJobType; input?: unknown }>(request);

  if (!payload.type || !jobsService.isAiJobType(payload.type)) {
    writeJson(response, 400, { error: "valid_job_type_required" });
    return;
  }

  const job = await jobsService.createJob(ctx, payload.type, payload.input);
  writeJson(response, 201, { job });
}

async function handleClaimJob(ctx: AppContext, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const payload = await readJsonBody<{ workerName?: string; acceptedTypes?: AiJobType[] }>(request);
  const workerName = payload.workerName?.trim();

  if (!workerName) {
    writeJson(response, 400, { error: "worker_name_required" });
    return;
  }

  const acceptedTypes = (payload.acceptedTypes ?? []).filter(jobsService.isAiJobType);
  if (acceptedTypes.length === 0) {
    writeJson(response, 400, { error: "accepted_types_required" });
    return;
  }

  const job = await jobsService.claimJob(ctx, workerName, acceptedTypes);
  writeJson(response, 200, { job: job ?? null });
}

async function handleCompleteJob(
  ctx: AppContext,
  jobId: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const payload = await readJsonBody<{ output?: unknown }>(request);

  try {
    const outcome = await jobsService.completeJob(ctx, jobId, payload.output);
    if (!outcome.ok) {
      writeJson(response, 404, { error: outcome.code });
      return;
    }

    writeJson(response, 200, { job: outcome.job });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected completion failure";
    writeJson(response, 500, { error: "job_completion_failed", message });
  }
}

async function handleFailJob(
  ctx: AppContext,
  jobId: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const payload = await readJsonBody<{ error?: string }>(request);

  try {
    const job = await jobsService.failJob(ctx, jobId, payload.error);
    writeJson(response, 200, { job });
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

// ---------------------------------------------------------------------------
// Crunch — scheduled knowledge-base tidying
// ---------------------------------------------------------------------------

async function handleTriggerCrunch(
  ctx: AppContext,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const payload = await readJsonBody<{ flowId?: string }>(request);
  try {
    const run = await crunchService.triggerCrunchRun(ctx, {
      flowId: payload.flowId?.trim() || undefined,
      trigger: "manual"
    });
    writeJson(response, run.status === "failed" ? 502 : 200, { run });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Crunch run failed to start";
    writeJson(response, 500, { error: "crunch_run_failed", message });
  }
}

async function handleUpdateCrunchSettings(
  ctx: AppContext,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const payload = await readJsonBody<{ flowId?: string; enabled?: boolean; cron?: string }>(request);
  const cron = typeof payload.cron === "string" ? payload.cron.trim() : "";
  if (!isValidCron(cron)) {
    writeJson(response, 400, {
      error: "valid_cron_required",
      message: "cron must be a standard 5-field expression, e.g. \"0 2 * * *\"."
    });
    return;
  }

  await crunchService.updateSettings(ctx, payload.flowId?.trim() || undefined, {
    enabled: Boolean(payload.enabled),
    cron
  });
  writeJson(response, 200, { settings: await crunchService.settingsForResponse(ctx) });
}

async function handlePublishCrunchRun(ctx: AppContext, runId: string, response: ServerResponse): Promise<void> {
  const outcome = await crunchService.publishRun(ctx, runId);
  if (!outcome.ok) {
    writeJson(response, outcome.status, { error: outcome.code, message: outcome.message });
    return;
  }

  writeJson(response, 200, { run: outcome.run, publication: outcome.publication });
}

let crunchTickInFlight = false;

function startCrunchScheduler(ctx: AppContext): void {
  const tickMs = Number.parseInt(process.env.CRUNCH_SCHEDULER_TICK_MS ?? "60000", 10);
  const timer = setInterval(() => void crunchSchedulerTick(ctx), Number.isFinite(tickMs) && tickMs > 0 ? tickMs : 60_000);
  // Don't keep the process alive solely for the scheduler.
  timer.unref?.();
  console.log(`Crunch scheduler started (tick ${Number.isFinite(tickMs) && tickMs > 0 ? tickMs : 60_000}ms)`);
}

// One tick: fire any enabled schedule whose nextRunAt is due, then reschedule it.
// Re-entrancy guarded so a slow direct run can't overlap the next tick.
async function crunchSchedulerTick(ctx: AppContext): Promise<void> {
  if (crunchTickInFlight) {
    return;
  }
  crunchTickInFlight = true;
  try {
    const now = Date.now();
    for (const setting of await ctx.stores.crunchRuns.listSettings()) {
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
      await ctx.stores.crunchRuns.touchSchedule(setting.flowId, new Date(now).toISOString(), nextRunAt.toISOString());
      console.log(`Crunch schedule due for flow ${setting.flowId ?? "default"}; starting scheduled run.`);
      try {
        await crunchService.triggerCrunchRun(ctx, { flowId: setting.flowId, trigger: "scheduled" });
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
  run(ctx: AppContext): Promise<void>;
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
function startScheduledTaskScheduler(ctx: AppContext): void {
  const tickMs = Number.parseInt(process.env.SCHEDULED_TASK_TICK_MS ?? "60000", 10);
  const interval = Number.isFinite(tickMs) && tickMs > 0 ? tickMs : 60_000;
  const timer = setInterval(() => void scheduledTaskTick(ctx), interval);
  timer.unref?.();
  console.log(`Scheduled task scheduler started (tick ${interval}ms)`);
}

async function scheduledTaskTick(ctx: AppContext): Promise<void> {
  if (scheduledTaskTickInFlight) {
    return;
  }
  scheduledTaskTickInFlight = true;
  try {
    const now = Date.now();
    for (const task of scheduledTaskDefinitions) {
      const setting = await ctx.stores.scheduledTasks.getSettings(task.key);
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
      await ctx.stores.scheduledTasks.touchSchedule(task.key, new Date(now).toISOString(), nextRunAt.toISOString());
      console.log(`Scheduled task ${task.key} due; running.`);
      try {
        await task.run(ctx);
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
async function refreshPullRequests(ctx: AppContext): Promise<void> {
  const open = await ctx.stores.proposals.list(200, { status: "pr-opened" });
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
      const merged = await ctx.stores.proposals.updateStatus(proposal.id, "merged");
      if (merged) {
        console.log(`Detected merged pull request for proposal ${proposal.id}; running merge cascade.`);
        await proposalsService.runMergeCascade(ctx, merged);
      }
    } else if (status.state === "closed") {
      // Closed without merging is effectively a rejection of the published
      // proposal; mark it so the task stops chasing a dead PR.
      await ctx.stores.proposals.updateStatus(proposal.id, "rejected");
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
async function coveredGapSummaries(ctx: AppContext): Promise<Set<string>> {
  const summaries = new Set<string>();
  for (const proposal of await ctx.stores.proposals.list(500)) {
    for (const summary of proposalsService.splitGapSummaries(proposal.gapSummary)) {
      summaries.add(summary);
    }
  }
  return summaries;
}

// End-to-end gap-to-PR pipeline. First drafts proposals for any gap cluster not
// already covered, then auto-promotes every draft to ready and publishes all
// draft/ready proposals as pull requests. Each step is best-effort and logged so
// one failure can't abort the whole run.
async function processGapsIntoPullRequests(ctx: AppContext): Promise<void> {
  // 1) Cluster the open gaps and draft a proposal for each uncovered cluster.
  const candidates = await ctx.stores.questionLogs.listGapCandidates(200);
  if (candidates.length > 0) {
    const clusters = await gapsService.clusterGapCandidates(ctx, candidates);
    const toDraft = selectClustersToDraft(
      clusters,
      candidates.map((candidate) => candidate.summary),
      await coveredGapSummaries(ctx)
    );
    for (const summaries of toDraft) {
      try {
        const outcome = await proposalsService.draftFromGaps(ctx, summaries);
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
    ...(await ctx.stores.proposals.list(200, { status: "draft" })),
    ...(await ctx.stores.proposals.list(200, { status: "ready" })),
    ...(await ctx.stores.proposals.list(200, { status: "branch-pushed" }))
  ];
  for (const proposal of pending) {
    let candidate = proposal;
    if (candidate.status === "draft") {
      const promoted = await ctx.stores.proposals.updateStatus(candidate.id, "ready");
      if (!promoted) {
        continue;
      }
      candidate = promoted;
    }

    try {
      const outcome = await proposalsService.publishReadyProposal(ctx, candidate);
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
async function scheduledTasksForResponse(ctx: AppContext): Promise<
  Array<{ key: string; label: string; description: string; settings: ScheduledTaskSettings }>
> {
  const stored = await ctx.stores.scheduledTasks.listSettings();
  const byKey = new Map(stored.map((setting) => [setting.key, setting]));
  return scheduledTaskDefinitions.map((task) => ({
    key: task.key,
    label: task.label,
    description: task.description,
    settings: byKey.get(task.key) ?? defaultScheduledTaskSettings(task)
  }));
}

async function handleUpdateScheduledTaskSettings(
  ctx: AppContext,
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

  await ctx.stores.scheduledTasks.updateSettings(key, { enabled: Boolean(payload.enabled), cron });
  writeJson(response, 200, { tasks: await scheduledTasksForResponse(ctx) });
}

async function handleRunScheduledTask(ctx: AppContext, key: string, response: ServerResponse): Promise<void> {
  const task = findScheduledTask(key);
  if (!task) {
    writeJson(response, 404, { error: "scheduled_task_not_found" });
    return;
  }

  try {
    await task.run(ctx);
    writeJson(response, 200, { ok: true, tasks: await scheduledTasksForResponse(ctx) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "scheduled task run failed";
    writeJson(response, 500, { error: "scheduled_task_run_failed", message });
  }
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

