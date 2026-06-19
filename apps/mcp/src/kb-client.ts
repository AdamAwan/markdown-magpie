// Shared Markdown Magpie API/KB client used by both MCP transports
// (src/main.ts stdio and src/http.ts Streamable HTTP). Keeping a single copy of
// the API plumbing avoids the apiUrl/postJson/getJson/askQuestion drift that
// comes from copy-pasting it per transport.

const apiBaseUrl = trimTrailingSlash(
  (process.env.API_BASE_URL ?? "http://localhost:4000").replace(/\/api$/, "")
);

// When the API answers questions asynchronously (queue execution mode), kb.ask
// polls the job until it produces an answer instead of returning queue metadata.
const answerPollIntervalMs = parsePositiveInt(process.env.ANSWER_POLL_INTERVAL_MS, 1000);
const answerTimeoutMs = parsePositiveInt(process.env.ANSWER_TIMEOUT_MS, 120000);

export interface AskResult {
  answer: string;
  confidence: string;
  citations: unknown[];
  gaps?: unknown[];
  questionId?: string;
}

interface JobView {
  status: string;
  output?: unknown;
  error?: string;
}

type FeedbackKind = "helpful" | "unhelpful" | "knowledge_gap";

// Optional downstream auth for API calls. When the MCP server runs as an OAuth
// protected resource it authenticates to the API with its own service token
// (never the inbound user token). Omitting `token` preserves the unauthenticated
// local-dev behaviour. Shared by both transports (stdio reuses this in Task 5).
export interface KbClientOptions {
  token?: string;
}

function authHeaders(options: KbClientOptions | undefined): Record<string, string> {
  return options?.token ? { authorization: `Bearer ${options.token}` } : {};
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function apiUrl(path: string): string {
  return path.startsWith("/api/") || path === "/api"
    ? `${apiBaseUrl}${path}`
    : `${apiBaseUrl}/api${path}`;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function postJson(path: string, body: unknown, options?: KbClientOptions): Promise<unknown> {
  const response = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(options) },
    body: JSON.stringify(body)
  });

  return readApiResponse(response, path);
}

export async function getJson(path: string, options?: KbClientOptions): Promise<unknown> {
  const response = await fetch(apiUrl(path), { headers: authHeaders(options) });
  return readApiResponse(response, path);
}

async function readApiResponse(response: Response, path: string): Promise<unknown> {
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(`API ${path} failed with ${response.status}: ${text}`);
  }

  return body;
}

// Asks the API a question and resolves to the final answer only. The API may
// answer inline (direct mode) or asynchronously via a job (queue mode); in the
// queue case we poll until the answer is ready so callers never see internal
// job, queue, or retrieval-context details.
export async function askQuestion(question: string, options?: KbClientOptions): Promise<AskResult> {
  const ask = asObject(await postJson("/ask", { question }, options));
  const questionId = typeof ask.questionId === "string" ? ask.questionId : undefined;
  const result =
    ask.result !== undefined ? extractAnswer(ask.result) : await waitForQueuedAnswer(readStatusPath(ask), options);

  return { ...result, questionId };
}

async function waitForQueuedAnswer(statusPath: string, options?: KbClientOptions): Promise<AskResult> {
  const deadline = Date.now() + answerTimeoutMs;

  for (;;) {
    const job = readJob(await getJson(statusPath, options));

    if (job.status === "completed") {
      if (job.output === undefined) {
        throw new Error("Answer job completed without producing an answer");
      }

      return extractAnswer(job.output);
    }

    if (job.status === "failed" || job.status === "cancelled") {
      throw new Error(job.error ?? `Answer job ${job.status}`);
    }

    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the answer to be generated");
    }

    await delay(answerPollIntervalMs);
  }
}

function readStatusPath(ask: Record<string, unknown>): string {
  const links = ask.links;
  if (links && typeof links === "object") {
    const status = (links as Record<string, unknown>).status;
    if (typeof status === "string" && status.length > 0) {
      return status;
    }
  }

  throw new Error("Queued answer response did not include a status link");
}

function readJob(value: unknown): JobView {
  const job = asObject(asObject(value).job);
  const status = job.status;
  if (typeof status !== "string") {
    throw new Error("Job status response did not include a status");
  }

  return {
    status,
    output: job.output,
    error: typeof job.error === "string" ? job.error : undefined
  };
}

function extractAnswer(value: unknown): AskResult {
  const record = asObject(value);
  const answer = record.answer;
  if (typeof answer !== "string") {
    throw new Error("Answer payload did not include answer text");
  }

  const result: AskResult = {
    answer,
    confidence: typeof record.confidence === "string" ? record.confidence : "low",
    citations: Array.isArray(record.citations) ? record.citations : []
  };

  if (Array.isArray(record.gaps) && record.gaps.length > 0) {
    result.gaps = record.gaps;
  }

  return result;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error("Expected an object response from the API");
  }

  return value as Record<string, unknown>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ── feedback ────────────────────────────────────────────────────────────────

function feedbackKindArgument(args: Record<string, unknown> | undefined): FeedbackKind {
  const value = args?.kind;
  if (value === "helpful" || value === "unhelpful" || value === "knowledge_gap") {
    return value;
  }

  throw new Error("kind must be one of 'helpful', 'unhelpful', or 'knowledge_gap'");
}

export function stringArgument(args: Record<string, unknown> | undefined, name: string): string {
  const value = args?.[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value.trim();
}

function optionalStringArgument(args: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = args?.[name];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function submitFeedback(
  args: Record<string, unknown> | undefined,
  options?: KbClientOptions
): Promise<unknown> {
  const questionId = stringArgument(args, "questionId");
  const kind = feedbackKindArgument(args);

  if (kind === "knowledge_gap") {
    const gapSummary = optionalStringArgument(args, "gapSummary");
    const body = gapSummary ? { summary: gapSummary } : {};
    const response = asObject(await postJson(`/questions/${encodeURIComponent(questionId)}/gap`, body, options));
    return { questionId, kind, question: response.question };
  }

  const response = asObject(
    await postJson(`/questions/${encodeURIComponent(questionId)}/feedback`, { feedback: kind }, options)
  );
  return { questionId, kind, question: response.question };
}
