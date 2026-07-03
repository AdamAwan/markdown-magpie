// Shared Markdown Magpie API/KB client used by both MCP transports
// (src/main.ts stdio and src/http.ts Streamable HTTP). Keeping a single copy of
// the API plumbing avoids the apiUrl/postJson/getJson/askQuestion drift that
// comes from copy-pasting it per transport.

import {
  ON_BEHALF_OF_ROLES_HEADER,
  ON_BEHALF_OF_SUBJECT_HEADER,
  serializeOnBehalfRoles
} from "@magpie/auth";

const apiBaseUrl = trimTrailingSlash(
  (process.env.API_BASE_URL ?? "http://localhost:4000").replace(/\/api$/, "")
);

// The API always answers questions asynchronously: POST /ask enqueues an
// answer_question job and returns 202 with { questionId, job, links }. kb_ask
// waits on the job's wait link (which long-polls server-side, returning 200 for
// a terminal job or 202 for the current projection when the wait limit expires)
// and falls back to detail polling until the job reaches a terminal state.
const answerPollIntervalMs = parsePositiveInt(process.env.ANSWER_POLL_INTERVAL_MS, 1000);
const answerTimeoutMs = parsePositiveInt(process.env.ANSWER_TIMEOUT_MS, 120000);

// Durable job lifecycle states (see @magpie/jobs JobState). created | retry |
// active are non-terminal; completed | cancelled | failed are terminal.
type JobState = "created" | "retry" | "active" | "completed" | "cancelled" | "failed" | "blocked";

export interface Flow {
  id: string;
  name: string;
}

export interface AskResult {
  answer: string;
  confidence: string;
  citations: unknown[];
  gaps?: unknown[];
  questionId?: string;
  // Present when "auto" routing could not determine a flow: the answer is a stock
  // note (confidence "unknown") and the caller should re-ask kb_ask with `flow`
  // set to one of these ids.
  flowSelectionRequired?: { availableFlows: Flow[] };
  // Present when the picked flow judged the question off-topic for its knowledge
  // area: the answer is a stock note (confidence "unknown"), no gaps were raised,
  // and re-asking will not help unless a different flow fits.
  outOfScope?: { reason?: string };
}

interface JobView {
  id: string;
  state: JobState;
  output?: unknown;
}

type FeedbackKind = "helpful" | "unhelpful" | "knowledge_gap";

// Optional downstream auth for API calls. When the MCP server runs as an OAuth
// protected resource it authenticates to the API with its own service token
// (never the inbound user token). Omitting `token` preserves the unauthenticated
// local-dev behaviour. Shared by both transports (stdio reuses this in Task 5).
//
// `token` may be a literal string (stdio's MCP_AUTH_TOKEN) or a provider
// function (the HTTP transport's runtime-refreshed M2M token). A provider is
// resolved on every call so an expired token is transparently refreshed.
export interface KbClientOptions {
  token?: string | (() => Promise<string | undefined>);
  // The verified end user this call is made on behalf of. When present, the client
  // forwards the user's subject + roles alongside the (service) bearer token, so the
  // API can authorize as the user (trusted on-behalf-of delegation). Resolved per
  // call so it reflects the current request's user (HTTP transport); undefined for
  // stdio, which has no per-request user context.
  onBehalfOf?: () => { subject?: string; roles?: string[] } | undefined;
}

async function authHeaders(options: KbClientOptions | undefined): Promise<Record<string, string>> {
  const token = typeof options?.token === "function" ? await options.token() : options?.token;
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};

  const actor = options?.onBehalfOf?.();
  if (actor) {
    if (actor.subject) {
      headers[ON_BEHALF_OF_SUBJECT_HEADER] = actor.subject;
    }
    // Always send the roles header when delegating — its presence is what activates
    // delegation on the API. A user with no roles yields "[]" (fail-closed: no flow
    // access) rather than silently falling back to the service identity's bypass.
    headers[ON_BEHALF_OF_ROLES_HEADER] = serializeOnBehalfRoles(actor.roles ?? []);
  }

  return headers;
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
    headers: { "content-type": "application/json", ...(await authHeaders(options)) },
    body: JSON.stringify(body)
  });

  return readApiResponse(response, path);
}

export async function getJson(path: string, options?: KbClientOptions): Promise<unknown> {
  const response = await fetch(apiUrl(path), { headers: await authHeaders(options) });
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

// Asks the API a question and resolves to the final answer only. POST /ask
// enqueues a durable answer_question job and returns links to it; we wait on the
// job (server-side long poll) and fall back to detail polling until it reaches a
// terminal state, so callers never see internal job, queue, or retrieval-context
// details. The terminal job's output is the envelope { result, executor }; the
// answer fields live in `result` (the answerQuestionOutputSchema shape).
export async function askQuestion(
  question: string,
  options?: KbClientOptions,
  flow?: string
): Promise<AskResult> {
  const body = flow ? { question, flow } : { question };
  const ask = asObject(await postJson("/ask", body, options));
  const questionId = typeof ask.questionId === "string" ? ask.questionId : undefined;
  const links = readLinks(ask);
  const deadline = Date.now() + answerTimeoutMs;

  const waited = readJob(await getJson(links.wait, options));
  const result =
    waited.state === "completed"
      ? extractAnswer(readResult(waited))
      : await pollForAnswer(links.job, waited, deadline, options);

  return { ...result, questionId };
}

// Falls back to detail polling (GET /jobs/:id) when the wait endpoint returns a
// non-terminal projection (202, state in created | retry | active). Maps every
// terminal state, and turns failed/cancelled or a deadline overrun into a clear
// error that names the job id and state but never echoes payload data.
async function pollForAnswer(
  jobPath: string,
  initial: JobView,
  deadline: number,
  options?: KbClientOptions
): Promise<AskResult> {
  let job = initial;

  for (;;) {
    switch (job.state) {
      case "completed":
        return extractAnswer(readResult(job));
      case "failed":
      case "cancelled":
        throw new Error(`Answer job ${job.id} ${job.state}`);
      // created | retry | active | blocked are non-terminal; keep polling.
      default:
        break;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for answer job ${job.id} (state ${job.state})`);
    }

    await delay(answerPollIntervalMs);
    job = readJob(await getJson(jobPath, options));
  }
}

interface AskLinks {
  wait: string;
  job: string;
}

function readLinks(ask: Record<string, unknown>): AskLinks {
  const links = asObject(ask.links);
  const wait = links.wait;
  const job = links.job;
  if (typeof wait !== "string" || wait.length === 0 || typeof job !== "string" || job.length === 0) {
    throw new Error("Ask response did not include job wait/detail links");
  }

  return { wait, job };
}

function readJob(value: unknown): JobView {
  const job = asObject(asObject(value).job);
  const id = job.id;
  const state = job.state;
  if (typeof id !== "string") {
    throw new Error("Job response did not include an id");
  }
  if (!isJobState(state)) {
    throw new Error("Job response did not include a valid state");
  }

  return { id, state, output: job.output };
}

function isJobState(value: unknown): value is JobState {
  return (
    value === "created" ||
    value === "retry" ||
    value === "active" ||
    value === "completed" ||
    value === "cancelled" ||
    value === "failed" ||
    value === "blocked"
  );
}

// Unwraps the terminal job output envelope { result, executor }, returning the
// `result` payload (the answerQuestionOutputSchema shape) that extractAnswer reads.
function readResult(job: JobView): unknown {
  if (job.output === undefined) {
    throw new Error(`Answer job ${job.id} completed without producing an answer`);
  }

  return asObject(job.output).result;
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

  const selection = readFlowSelectionRequired(record.flowSelectionRequired);
  if (selection) {
    result.flowSelectionRequired = selection;
  }

  const outOfScope = readOutOfScope(record.outOfScope);
  if (outOfScope) {
    result.outOfScope = outOfScope;
  }

  return result;
}

// Reads the structured "off-topic for this flow" signal off an answer payload,
// tolerating a missing/malformed field by returning undefined.
function readOutOfScope(value: unknown): { reason?: string } | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const reason = (value as { reason?: unknown }).reason;
  return typeof reason === "string" ? { reason } : {};
}

// Reads the structured "pick a flow" signal off an answer payload, tolerating a
// missing/malformed field by returning undefined (the answer note still stands).
function readFlowSelectionRequired(value: unknown): { availableFlows: Flow[] } | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const flows = (value as { availableFlows?: unknown }).availableFlows;
  if (!Array.isArray(flows)) {
    return undefined;
  }

  return { availableFlows: flows.filter(isFlow) };
}

function isFlow(value: unknown): value is Flow {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as Flow).id === "string" &&
    typeof (value as Flow).name === "string"
  );
}

// Lists the flows a caller can pin a question to (GET /knowledge/flows), so an
// MCP agent can specify `flow` on the first kb_ask rather than waiting to be asked.
export async function listFlows(options?: KbClientOptions): Promise<{ flows: Flow[] }> {
  const response = asObject(await getJson("/knowledge/flows", options));
  const flows = Array.isArray(response.flows) ? response.flows.filter(isFlow) : [];
  return { flows };
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

export function optionalStringArgument(args: Record<string, unknown> | undefined, name: string): string | undefined {
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

// Seeds a flow with initial content in one shot: `items` (each a title + the points
// it should cover) are drafted straight into proposals → PRs, bypassing the gap
// pipeline. The item shape is validated server-side by the seed endpoint; we pass it
// through so the tool stays a thin surface over POST /flows/:id/seed.
export async function seedFlow(
  args: Record<string, unknown> | undefined,
  options?: KbClientOptions
): Promise<unknown> {
  const flow = stringArgument(args, "flow");
  const items = args?.items;
  return asObject(await postJson(`/flows/${encodeURIComponent(flow)}/seed`, { items }, options));
}

// ── seed outline ──────────────────────────────────────────────────────────────

// Outline generation queues an outline_flow_seed job (a single grounded model
// call) with a generous expiry; wait a few minutes rather than the answer path's
// 2-minute budget. Both are overridable for slow providers / test harnesses.
const outlinePollIntervalMs = parsePositiveInt(process.env.OUTLINE_POLL_INTERVAL_MS, 1500);
const outlineTimeoutMs = parsePositiveInt(process.env.OUTLINE_TIMEOUT_MS, 180000);

// A proposed seed document as the outline model returns it: a title plus the
// points it should cover. Mirrors the API's SeedItem — this is exactly the item
// shape kb_seed consumes. `coverage` may be empty in raw model output (the caller
// reviews and fills it in before seeding), so it is not required here.
export interface OutlineItem {
  title?: string;
  targetPath?: string;
  coverage: string[];
  questions?: string[];
}

export interface OutlineResult {
  jobId: string;
  items: OutlineItem[];
  rationale?: string;
}

// Generates a seed outline for a topic WITHOUT seeding anything: POST
// /flows/:id/outline enqueues an outline_flow_seed job (grounded in the flow's
// existing docs and persona) and returns { ok, jobId }. We wait on the job — its
// server-side long-poll wait link first, then detail polling — until it reaches a
// terminal state, unwrap the { result, executor } envelope, and return the
// proposed items + rationale. The caller reviews/edits the items and passes them
// to kb_seed; this function deliberately never seeds on its own.
export async function generateOutline(
  args: Record<string, unknown> | undefined,
  options?: KbClientOptions
): Promise<OutlineResult> {
  const flow = stringArgument(args, "flow");
  const topic = stringArgument(args, "topic");
  const notes = optionalStringArgument(args, "notes");
  const body = notes ? { topic, notes } : { topic };

  const created = asObject(await postJson(`/flows/${encodeURIComponent(flow)}/outline`, body, options));
  const jobId = created.jobId;
  if (typeof jobId !== "string" || jobId.length === 0) {
    throw new Error("Outline response did not include a job id");
  }

  const deadline = Date.now() + outlineTimeoutMs;
  const job = await waitForOutlineJob(jobId, deadline, options);
  return { jobId, ...readOutline(job) };
}

// Waits for an outline job to reach a terminal state. Mirrors askQuestion's
// strategy: hit the job's server-side long-poll wait endpoint once, then fall
// back to detail polling. Turns failed/cancelled or a deadline overrun into a
// clear error that names the job id and state but never echoes payload data.
async function waitForOutlineJob(
  jobId: string,
  deadline: number,
  options?: KbClientOptions
): Promise<JobView> {
  const encoded = encodeURIComponent(jobId);
  let job = readJob(await getJson(`/jobs/${encoded}/wait`, options));

  for (;;) {
    switch (job.state) {
      case "completed":
        return job;
      case "failed":
      case "cancelled":
        throw new Error(`Outline job ${job.id} ${job.state}`);
      // created | retry | active | blocked are non-terminal; keep polling.
      default:
        break;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for outline job ${job.id} (state ${job.state})`);
    }

    await delay(outlinePollIntervalMs);
    job = readJob(await getJson(`/jobs/${encoded}`, options));
  }
}

// Unwraps a completed outline job's { result, executor } envelope into the
// proposed items + rationale. Tolerates a missing rationale but requires the
// result to carry an items array — that array is the whole point of the outline.
function readOutline(job: JobView): { items: OutlineItem[]; rationale?: string } {
  if (job.output === undefined) {
    throw new Error(`Outline job ${job.id} completed without producing an outline`);
  }

  const result = asObject(asObject(job.output).result);
  if (!Array.isArray(result.items)) {
    throw new Error(`Outline job ${job.id} completed without an items array`);
  }

  const items = result.items.filter(isOutlineItem);
  const rationale = typeof result.rationale === "string" ? result.rationale : undefined;
  return rationale ? { items, rationale } : { items };
}

function isOutlineItem(value: unknown): value is OutlineItem {
  if (!value || typeof value !== "object") {
    return false;
  }

  const coverage = (value as { coverage?: unknown }).coverage;
  return Array.isArray(coverage) && coverage.every((point) => typeof point === "string");
}
