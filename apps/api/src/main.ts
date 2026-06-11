import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AiExecutionMode, AiJobType, AnswerQuestionJobInput } from "@magpie/core";
import { answerQuestion, createChatProvider, type ChatProviderName } from "@magpie/retrieval";
import { InMemoryAiJobQueue } from "./ai-job-queue.js";
import { InMemoryKnowledgeIndex } from "./knowledge-index.js";
import { PostgresAiJobQueue } from "./postgres-ai-job-queue.js";
import { PostgresKnowledgeStore } from "./postgres-knowledge-store.js";

const port = Number.parseInt(process.env.PORT ?? "4000", 10);
const aiExecutionMode = normalizeAiExecutionMode(process.env.AI_EXECUTION_MODE);
const aiJobs = createAiJobQueue();
const knowledgeIndex = createKnowledgeIndex();
const chatProvider = createConfiguredChatProvider();

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    writeJson(response, 500, { error: "internal_error", message });
  }
});

server.listen(port, () => {
  console.log(`Markdown Magpie API listening on http://localhost:${port}`);
  console.log(`AI execution mode: ${aiExecutionMode}`);
  console.log(`Chat provider: ${normalizeChatProviderName(process.env.CHAT_PROVIDER)}`);
});

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const path = url.pathname;

  if (request.method === "GET" && path === "/health") {
    writeJson(response, 200, { ok: true, service: "markdown-magpie-api" });
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

    writeJson(response, 200, { sections: await knowledgeIndex.search(query, 5) });
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

async function handleAsk(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const payload = await readJsonBody<{ question?: string }>(request);
  const question = payload.question?.trim();

  if (!question) {
    writeJson(response, 400, { error: "question_required" });
    return;
  }

  if (aiExecutionMode === "queue") {
    const sections = await knowledgeIndex.search(question, 5);
    const input: AnswerQuestionJobInput = {
      question,
      context: sections.map((section) => ({
        sectionId: section.id,
        path: section.path,
        heading: section.heading,
        content: section.content
      })),
      expectedOutput: "answer_result"
    };
    const job = await aiJobs.enqueue("answer_question", input);
    writeJson(response, 202, {
      mode: "queue",
      job,
      links: {
        status: `/ai-jobs/${job.id}`
      }
    });
    return;
  }

  const result = await answerQuestion(
    question,
    knowledgeIndex,
    chatProvider
  );

  writeJson(response, 200, {
    mode: aiExecutionMode,
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
    await aiJobs.complete(jobId, payload.output ?? {});
    writeJson(response, 200, { job: await aiJobs.get(jobId) });
  } catch {
    writeJson(response, 404, { error: "job_not_found" });
  }
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
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function normalizeAiExecutionMode(value: string | undefined): AiExecutionMode {
  if (value === "direct" || value === "queue") {
    return value;
  }

  return "mock";
}

function createAiJobQueue(): InMemoryAiJobQueue | PostgresAiJobQueue {
  if (process.env.AI_JOB_QUEUE === "postgres") {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required when AI_JOB_QUEUE=postgres");
    }

    return new PostgresAiJobQueue(databaseUrl);
  }

  return new InMemoryAiJobQueue();
}

function createKnowledgeIndex(): InMemoryKnowledgeIndex {
  if (process.env.KNOWLEDGE_STORE === "postgres") {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required when KNOWLEDGE_STORE=postgres");
    }

    return new InMemoryKnowledgeIndex(new PostgresKnowledgeStore(databaseUrl));
  }

  return new InMemoryKnowledgeIndex();
}

function createConfiguredChatProvider() {
  return createChatProvider({
    provider: normalizeChatProviderName(process.env.CHAT_PROVIDER),
    apiKey: process.env.OPENAI_COMPATIBLE_API_KEY || process.env.AZURE_OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL,
    model: process.env.OPENAI_COMPATIBLE_MODEL,
    azureEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
    azureDeployment: process.env.AZURE_OPENAI_CHAT_DEPLOYMENT,
    azureApiVersion: process.env.AZURE_OPENAI_API_VERSION
  });
}

function normalizeChatProviderName(value: string | undefined): ChatProviderName {
  if (value === "openai-compatible" || value === "azure-openai") {
    return value;
  }

  return "mock";
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
