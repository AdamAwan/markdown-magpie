import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type {
  AiExecutionMode,
  AiJob,
  AiJobType,
  AnswerQuestionJobInput,
  AnswerQuestionJobOutput,
  DraftMarkdownProposalJobInput,
  DraftMarkdownProposalJobOutput,
  Proposal,
  RepositoryRef,
  QuestionFeedback
} from "@magpie/core";
import { LocalGitProposalPublisher } from "@magpie/git";
import { answerQuestion, createChatProvider, createEmbeddingProvider, type ChatProviderName, type EmbeddingProviderName } from "@magpie/retrieval";
import { DEFAULT_AI_JOB_CLAIM_TIMEOUT_MS, InMemoryAiJobQueue } from "./ai-job-queue.js";
import { embedPendingSections } from "./embed-sections.js";
import { InMemoryKnowledgeIndex } from "./knowledge-index.js";
import { PostgresAiJobQueue } from "./postgres-ai-job-queue.js";
import { PostgresKnowledgeStore } from "./postgres-knowledge-store.js";
import { PostgresProposalStore } from "./postgres-proposal-store.js";
import { PostgresQuestionLogStore } from "./postgres-question-log-store.js";
import { InMemoryProposalStore } from "./proposal-store.js";
import { InMemoryQuestionLogStore } from "./question-log-store.js";

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
let runtimeConfig = createInitialRuntimeConfig();

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
    await knowledgeIndex.hydrate();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`Failed to hydrate knowledge index from storage: ${message}`);
  }

  server.listen(port, () => {
    console.log(`Markdown Magpie API listening on http://localhost:${port}`);
    console.log(`AI execution mode: ${runtimeConfig.aiExecutionMode}`);
    console.log(`AI provider: ${runtimeConfig.aiProvider}`);
  });
}

void start();

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const path = url.pathname;

  if (request.method === "OPTIONS") {
    writeJson(response, 204, undefined);
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

  if (request.method === "GET" && path === "/gaps/candidates") {
    const limit = parseLimit(url.searchParams.get("limit"), 50);
    writeJson(response, 200, { gaps: await questionLogs.listGapCandidates(limit) });
    return;
  }

  if (request.method === "GET" && path === "/proposals") {
    const limit = parseLimit(url.searchParams.get("limit"), 50);
    writeJson(response, 200, { proposals: await proposals.list(limit) });
    return;
  }

  if (request.method === "POST" && path === "/proposals/from-gap") {
    await handleCreateProposalFromGap(request, response);
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

  writeJson(response, 200, { proposal });
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

  const repository = findRepositoryForProposal(proposal);
  if (!repository) {
    writeJson(response, 409, {
      error: "proposal_repository_not_found",
      message: "No indexed Git repository matches this proposal target path."
    });
    return;
  }

  if (repository.git?.scope === "not-git" || !repository.git?.workTreeRoot) {
    writeJson(response, 409, {
      error: "proposal_repository_not_git",
      message: "The matched repository is not a Git checkout."
    });
    return;
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
    const updatedProposal = await proposals.recordPublication(proposal.id, {
      provider: "local-git",
      branchName: publication.branchName,
      commitSha: publication.commitSha,
      remoteUrl: publication.remoteUrl,
      publishedAt: new Date().toISOString()
    });

    writeJson(response, 200, { proposal: updatedProposal, publication });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Proposal publish failed";
    writeJson(response, 409, { error: "proposal_publish_failed", message });
  }
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

async function handleCreateProposalFromGap(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const payload = await readJsonBody<{ summary?: string; targetPath?: string }>(request);
  const summary = payload.summary?.trim();

  if (!summary) {
    writeJson(response, 400, { error: "gap_summary_required" });
    return;
  }

  const gaps = await questionLogs.listGapCandidates(200);
  const gap = gaps.find((candidate) => candidate.summary === summary);
  if (!gap) {
    writeJson(response, 404, { error: "gap_candidate_not_found" });
    return;
  }

  const logs = (await Promise.all(gap.questionIds.map((id) => questionLogs.get(id)))).filter(
    (log): log is NonNullable<typeof log> => Boolean(log)
  );
  const evidence = logs.flatMap((log) => log.answer?.citations ?? []);
  const input: DraftMarkdownProposalJobInput = {
    gapSummary: gap.summary,
    triggeringQuestions: logs.map((log) => log.question),
    evidence,
    targetPath: payload.targetPath?.trim() || undefined,
    provider: runtimeConfig.aiProvider,
    expectedOutput: "markdown_proposal"
  } as DraftMarkdownProposalJobInput & { provider: AiProviderName };
  const job = await aiJobs.enqueue("draft_markdown_proposal", {
    ...input,
    triggeringQuestionIds: gap.questionIds
  });

  writeJson(response, 202, {
    job,
    links: {
      status: `/ai-jobs/${job.id}`,
      proposals: "/proposals"
    }
  });
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
        question: `/questions/${log.id}`,
        status: `/ai-jobs/${job.id}`
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

async function handleIndexRepository(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const payload = await readJsonBody<{ localPath?: string; repositoryId?: string; name?: string }>(request);
  const localPath = payload.localPath?.trim() || process.env.KNOWLEDGE_REPO_PATH;

  if (!localPath) {
    writeJson(response, 400, { error: "local_path_required" });
    return;
  }

  const summary = await knowledgeIndex.indexLocalRepository({
    localPath,
    repositoryId: payload.repositoryId,
    name: payload.name
  });

  writeJson(response, 200, summary);
  void embedSectionsInBackground();
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
    await aiJobs.fail(jobId, payload.error ?? "Unknown watcher failure");
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
    "access-control-allow-methods": "GET,POST,OPTIONS",
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
      repositoryPath: process.env.KNOWLEDGE_REPO_PATH ?? null
    },
    providers: {
      llmProvider: process.env.LLM_PROVIDER ?? "mock",
      embeddingProvider: embeddingProviderName() ?? "mock",
      gitProvider: process.env.GIT_PROVIDER ?? "local",
      openAiCompatible: {
        baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL || null,
        model: process.env.OPENAI_COMPATIBLE_MODEL || null,
        embeddingModel: process.env.OPENAI_COMPATIBLE_EMBEDDING_MODEL || null,
        apiKey: secretState(process.env.OPENAI_COMPATIBLE_API_KEY)
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

function secretState(value: string | undefined): "set" | "not set" {
  return value ? "set" : "not set";
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
    evidence: input.evidence ?? [],
    gapSummary: input.gapSummary,
    triggeringQuestionIds: input.triggeringQuestionIds,
    jobId: job.id
  });
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

function embeddingProviderName(): EmbeddingProviderName | undefined {
  if (process.env.OPENAI_COMPATIBLE_BASE_URL && process.env.OPENAI_COMPATIBLE_API_KEY && process.env.OPENAI_COMPATIBLE_EMBEDDING_MODEL) {
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
    apiKey: process.env.OPENAI_COMPATIBLE_API_KEY || process.env.AZURE_OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL,
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

function storeBackend(name: "KNOWLEDGE_STORE" | "QUESTION_LOG_STORE" | "PROPOSAL_STORE" | "AI_JOB_QUEUE"): "memory" | "postgres" {
  return process.env[name] === "postgres" ? "postgres" : storageBackend();
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

function parseLimit(value: string | null, defaultLimit: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return defaultLimit;
  }

  return Math.max(1, Math.min(parsed, 200));
}

function normalizeUploadPath(value: string | undefined): string {
  const path = value?.trim().replace(/\\/g, "/").replace(/^\/+/, "") ?? "";
  if (!path || path.includes("..")) {
    return "";
  }

  return path.toLowerCase().endsWith(".md") ? path : `${path}.md`;
}

function isAiJobType(value: unknown): value is AiJobType {
  return (
    value === "answer_question" ||
    value === "summarize_gap" ||
    value === "draft_markdown_proposal" ||
    value === "detect_contradiction" ||
    value === "suggest_consolidation"
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

function findRepositoryForProposal(proposal: Proposal): RepositoryRef | undefined {
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

function createProposalBranchName(proposal: Proposal): string {
  return `magpie/proposal-${proposal.id.slice(0, 8)}-${slugify(proposal.title).slice(0, 40)}`;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "docs-update"
  );
}

function normalizeRelativePath(value: string | undefined): string {
  return value?.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") ?? "";
}
