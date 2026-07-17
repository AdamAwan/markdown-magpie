// Shared Markdown Magpie API/KB client used by both MCP transports
// (src/main.ts stdio and src/http.ts Streamable HTTP). Keeping a single copy of
// the API plumbing avoids the apiUrl/postJson/getJson/askQuestion drift that
// comes from copy-pasting it per transport.

import { ON_BEHALF_OF_ROLES_HEADER, ON_BEHALF_OF_SUBJECT_HEADER, serializeOnBehalfRoles } from "@magpie/auth";

const apiBaseUrl = trimTrailingSlash((process.env.API_BASE_URL ?? "http://localhost:4000").replace(/\/api$/, ""));

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
  // The conversation this exchange belongs to (#239). Returned from POST /ask (the
  // API mints it on the first turn). Pass it back as `conversationId` on the next
  // kb_ask to ask a follow-up that resolves against this exchange.
  conversationId?: string;
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
  return path.startsWith("/api/") || path === "/api" ? `${apiBaseUrl}${path}` : `${apiBaseUrl}/api${path}`;
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

// API call failure carrying the HTTP status so callers can branch on it (e.g.
// kb_citation treats a per-section 404 as "missing", not a tool failure).
// Internal on purpose: kb_citation's 404 branch is the only status-sensitive
// caller, and an unused export would trip the strict dead-code gate.
class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function readApiResponse(response: Response, path: string): Promise<unknown> {
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new ApiError(response.status, `API ${path} failed with ${response.status}: ${text}`);
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
  flow?: string,
  conversationId?: string
): Promise<AskResult> {
  const body = {
    question,
    ...(flow ? { flow } : {}),
    // Attach this ask to an existing conversation (#239) when the caller threads
    // one; omitted starts a new conversation the API mints an id for.
    ...(conversationId ? { conversationId } : {})
  };
  const ask = asObject(await postJson("/ask", body, options));
  const questionId = typeof ask.questionId === "string" ? ask.questionId : undefined;
  // Echo the conversation id back to the caller (minted on the first turn, or the
  // one it passed) so a follow-up can be threaded onto this exchange.
  const returnedConversationId = typeof ask.conversationId === "string" ? ask.conversationId : conversationId;
  const links = readLinks(ask);
  const deadline = Date.now() + answerTimeoutMs;

  const waited = readJob(await getJson(links.wait, options));
  const result =
    waited.state === "completed"
      ? extractAnswer(readResult(waited))
      : await pollForAnswer(links.job, waited, deadline, options);

  return { ...result, questionId, ...(returnedConversationId ? { conversationId: returnedConversationId } : {}) };
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

// ── citation sections ─────────────────────────────────────────────────────────

const MAX_CITATION_SECTION_IDS = 20;

// Validates kb_citation's sectionIds argument: a 1–20 entry array of non-empty
// strings, deduplicated preserving first-seen order (an answer can cite the same
// section twice; fetching it twice buys nothing).
function sectionIdsArgument(args: Record<string, unknown> | undefined): string[] {
  const value = args?.sectionIds;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("sectionIds must be a non-empty array of section id strings");
  }
  if (value.length > MAX_CITATION_SECTION_IDS) {
    throw new Error(`sectionIds accepts at most ${MAX_CITATION_SECTION_IDS} ids per call`);
  }

  const ids = value.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error("sectionIds entries must be non-empty strings");
    }
    return entry.trim();
  });

  return [...new Set(ids)];
}

// Fetches the full content of cited sections (GET /knowledge/sections/:id per
// id, in parallel). A per-id 404 means the section was re-indexed away since
// the answer cited it — it lands in `missing` rather than failing the call, so
// the evidence that still resolves is returned. Any other API failure rejects.
export async function getCitationSections(
  args: Record<string, unknown> | undefined,
  options?: KbClientOptions
): Promise<{ sections: unknown[]; missing: string[] }> {
  const sectionIds = sectionIdsArgument(args);

  const resolved = await Promise.all(
    sectionIds.map(async (id) => {
      try {
        const response = asObject(await getJson(`/knowledge/sections/${encodeURIComponent(id)}`, options));
        return { id, section: response.section };
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          return { id, section: undefined };
        }
        throw error;
      }
    })
  );

  return {
    sections: resolved.filter((entry) => entry.section !== undefined).map((entry) => entry.section),
    missing: resolved.filter((entry) => entry.section === undefined).map((entry) => entry.id)
  };
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

// Approves a persisted seed plan (from kb_outline or the console): POST
// /seed-plans/:id/approve drafts one document per approved item straight into
// the proposal → PR pipeline, carrying the plan's run-scoped charter/persona.
// Thin surface — status rules (409 on a non-proposed plan) are server-side.
export async function approveSeedPlan(
  args: Record<string, unknown> | undefined,
  options?: KbClientOptions
): Promise<{ planId: string; jobIds: string[] }> {
  const plan = stringArgument(args, "plan");
  const response = asObject(await postJson(`/seed-plans/${encodeURIComponent(plan)}/approve`, {}, options));
  const jobIds = Array.isArray(response.jobIds)
    ? response.jobIds.filter((id): id is string => typeof id === "string")
    : [];
  return { planId: plan, jobIds };
}

// ── seed outline ──────────────────────────────────────────────────────────────

// Outline generation queues an outline_flow_seed job (a single grounded model
// call) with a generous expiry; wait a few minutes rather than the answer path's
// 2-minute budget. Both are overridable for slow providers / test harnesses.
const outlinePollIntervalMs = parsePositiveInt(process.env.OUTLINE_POLL_INTERVAL_MS, 1500);
const outlineTimeoutMs = parsePositiveInt(process.env.OUTLINE_TIMEOUT_MS, 180000);

export interface OutlineResult {
  // The persisted seed plan the run produced — approve it with kb_seed (or
  // review/edit it in the console).
  planId: string;
  // The run-scoped charter/persona. The *Proposed flags record that the value
  // came from the model (the flow config lacked one) — copy it into
  // KNOWLEDGE_FLOWS to make it permanent.
  charter?: string;
  charterProposed: boolean;
  persona?: string;
  personaProposed: boolean;
  // The proposed documents: each a title plus the points it should cover.
  // `coverage` may be empty in raw model output (a human edits before
  // approving), so it is not required here. Typed inline so this public return
  // type carries the shape without a separately-exported element alias for the
  // dead-code check to flag.
  items: {
    title?: string;
    targetPath?: string;
    coverage: string[];
    questions?: string[];
  }[];
  rationale?: string;
}

// Internal element alias for the outline item shape, derived from the public
// return type so the two never drift. Not exported (nothing outside names it), so
// it is invisible to the dead-code check.
type OutlineItem = OutlineResult["items"][number];

// Proposes a seed plan for a flow WITHOUT drafting anything: POST
// /flows/:id/outline enqueues the source-grounded outline_flow_seed job (no
// topic — the agent explores the flow's sources and plans the whole flow) and
// returns { ok, jobId }. We wait on the job — its server-side long-poll wait
// link first, then detail polling — until it reaches a terminal state, then
// fetch the persisted plan its completion created and return it. Approval
// (kb_seed / the console) is the only path that drafts.
export async function generateOutline(
  args: Record<string, unknown> | undefined,
  options?: KbClientOptions
): Promise<OutlineResult> {
  const flow = stringArgument(args, "flow");
  const notes = optionalStringArgument(args, "notes");
  const body = notes ? { notes } : {};

  const created = asObject(await postJson(`/flows/${encodeURIComponent(flow)}/outline`, body, options));
  const jobId = created.jobId;
  if (typeof jobId !== "string" || jobId.length === 0) {
    throw new Error("Outline response did not include a job id");
  }

  const deadline = Date.now() + outlineTimeoutMs;
  await waitForOutlineJob(jobId, deadline, options);
  const plans = asObject(await getJson(`/flows/${encodeURIComponent(flow)}/seed-plans`, options));
  const plan = (Array.isArray(plans.plans) ? plans.plans : [])
    .map((candidate) => asObject(candidate))
    .find((candidate) => candidate.outlineJobId === jobId);
  if (!plan) {
    throw new Error(`Outline job ${jobId} completed but no persisted plan was found for it`);
  }
  return readPlan(plan);
}

// Waits for an outline job to reach a terminal state. Mirrors askQuestion's
// strategy: hit the job's server-side long-poll wait endpoint once, then fall
// back to detail polling. Turns failed/cancelled or a deadline overrun into a
// clear error that names the job id and state but never echoes payload data.
async function waitForOutlineJob(jobId: string, deadline: number, options?: KbClientOptions): Promise<JobView> {
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

// Projects a persisted seed-plan row into the tool's return shape. Requires an
// id and an items array — those are the whole point of the plan; everything
// else degrades to absent.
function readPlan(plan: Record<string, unknown>): OutlineResult {
  const planId = plan.id;
  if (typeof planId !== "string" || planId.length === 0) {
    throw new Error("Seed plan response did not include a plan id");
  }
  if (!Array.isArray(plan.items)) {
    throw new Error(`Seed plan ${planId} carries no items array`);
  }
  const items = plan.items.filter(isOutlineItem);
  const rationale = typeof plan.rationale === "string" ? plan.rationale : undefined;
  return {
    planId,
    ...(typeof plan.charter === "string" ? { charter: plan.charter } : {}),
    charterProposed: plan.charterProposed === true,
    ...(typeof plan.persona === "string" ? { persona: plan.persona } : {}),
    personaProposed: plan.personaProposed === true,
    items,
    ...(rationale ? { rationale } : {})
  };
}

function isOutlineItem(value: unknown): value is OutlineItem {
  if (!value || typeof value !== "object") {
    return false;
  }

  const coverage = (value as { coverage?: unknown }).coverage;
  return Array.isArray(coverage) && coverage.every((point) => typeof point === "string");
}

// ── questionnaires ────────────────────────────────────────────────────────────
//
// Questionnaire mode (docs/questionnaires.md): a named batch of questions
// answered against one flow, with verbatim reuse of previously approved
// answers while the KB sections they cited are unchanged. These wrappers are
// deliberately non-waiting: creation fans fresh/changed items into the
// answer_question queue through a per-questionnaire drip, and a batch can be
// hundreds of questions — so create/get return the worksheet as-is (items may
// still be pending/answering) and the caller re-reads with getQuestionnaire
// until it settles. Contrast generateOutline above, which waits: outlining is
// a single job.

// Mirrors the API route bound (createQuestionnaireSchema: 1–500 questions).
const MAX_QUESTIONNAIRE_QUESTIONS = 500;

// Validates a bounded array of non-empty strings, trimming each entry. Unlike
// sectionIdsArgument this never dedupes: questionnaires legitimately carry
// near-duplicate questions, and item positions must line up with the input.
function stringArrayArgument(args: Record<string, unknown> | undefined, name: string, maxEntries: number): string[] {
  const value = args?.[name];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty array of strings`);
  }
  if (value.length > maxEntries) {
    throw new Error(`${name} accepts at most ${maxEntries} entries per call`);
  }

  return value.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`${name} entries must be non-empty strings`);
    }
    return entry.trim();
  });
}

// The worksheet shape the questionnaire tools return: the API's questionnaire
// JSON with light shaping. Internal plumbing the model has no use for is
// dropped (questionLogId, reusedFromItemId, citation contentHash/sectionId
// fingerprints); the item id stays because approveQuestionnaire targets it.
export interface QuestionnaireView {
  id: string;
  name: string;
  flowId: string;
  status: string;
  items: {
    id: string;
    position: number;
    question: string;
    status: string;
    outcome?: string;
    answer?: string;
    // Self-reported answer confidence (high | medium | low | unknown),
    // snapshotted onto the item — a display/review badge, not a suppressor.
    confidence?: string;
    // Machine-readable reason a matched item could not be reused verbatim
    // (which section changed/vanished/appeared) — passed through untouched.
    changeReason?: Record<string, unknown>;
    citations: { path: string; heading: string }[];
  }[];
}

// Internal element alias derived from the public return type so the two never
// drift (same pattern as OutlineItem above).
type QuestionnaireViewItem = QuestionnaireView["items"][number];

// Creates a questionnaire: POST /questionnaires. Returns immediately with the
// initial worksheet — reused items already carry answers; fresh/changed items
// drip through the answer queue and show up on subsequent reads.
export async function createQuestionnaire(
  args: Record<string, unknown> | undefined,
  options?: KbClientOptions
): Promise<QuestionnaireView> {
  const name = stringArgument(args, "name");
  const flow = stringArgument(args, "flow");
  const questions = stringArrayArgument(args, "questions", MAX_QUESTIONNAIRE_QUESTIONS);
  return readQuestionnaire(await postJson("/questionnaires", { name, flowId: flow, questions }, options));
}

// Reads a questionnaire worksheet: GET /questionnaires/:id. Server-side this
// also resumes a stalled drip, so polling this endpoint is what advances a
// questionnaire after an API restart.
export async function getQuestionnaire(
  args: Record<string, unknown> | undefined,
  options?: KbClientOptions
): Promise<QuestionnaireView> {
  const questionnaire = stringArgument(args, "questionnaire");
  return readQuestionnaire(await getJson(`/questionnaires/${encodeURIComponent(questionnaire)}`, options));
}

// Approves answers into the match corpus for future questionnaires: all reused
// items by default (POST /questionnaires/:id/approve-reused → { approved }),
// or one item by id (POST /questionnaires/:id/items/:itemId/approve → { ok }).
// Status rules (409 unless the item is answered) are server-side.
export async function approveQuestionnaire(
  args: Record<string, unknown> | undefined,
  options?: KbClientOptions
): Promise<{ approved: number } | { ok: true }> {
  const questionnaire = stringArgument(args, "questionnaire");
  const item = optionalStringArgument(args, "item");
  if (item) {
    await postJson(
      `/questionnaires/${encodeURIComponent(questionnaire)}/items/${encodeURIComponent(item)}/approve`,
      {},
      options
    );
    return { ok: true };
  }

  const response = asObject(
    await postJson(`/questionnaires/${encodeURIComponent(questionnaire)}/approve-reused`, {}, options)
  );
  return { approved: typeof response.approved === "number" ? response.approved : 0 };
}

// Projects the API's { questionnaire } envelope into the view. Requires the
// identity fields — they are the whole point of the response; item projection
// degrades per-field instead (a malformed optional never hides the worksheet).
function readQuestionnaire(value: unknown): QuestionnaireView {
  const questionnaire = asObject(asObject(value).questionnaire);
  const { id, name, flowId, status } = questionnaire;
  if (typeof id !== "string" || typeof name !== "string" || typeof flowId !== "string" || typeof status !== "string") {
    throw new Error("Questionnaire response did not include id/name/flowId/status");
  }

  const items = Array.isArray(questionnaire.items) ? questionnaire.items.map(readQuestionnaireItem) : [];
  return { id, name, flowId, status, items };
}

function readQuestionnaireItem(value: unknown): QuestionnaireViewItem {
  const item = asObject(value);
  const { id, question, status } = item;
  if (typeof id !== "string" || typeof question !== "string" || typeof status !== "string") {
    throw new Error("Questionnaire item did not include id/question/status");
  }

  const citations = Array.isArray(item.citations)
    ? item.citations.map((citation) => {
        const record = asObject(citation);
        return {
          path: typeof record.path === "string" ? record.path : "",
          heading: typeof record.heading === "string" ? record.heading : ""
        };
      })
    : [];

  return {
    id,
    position: typeof item.position === "number" ? item.position : 0,
    question,
    status,
    ...(typeof item.outcome === "string" ? { outcome: item.outcome } : {}),
    ...(typeof item.answer === "string" ? { answer: item.answer } : {}),
    ...(typeof item.confidence === "string" ? { confidence: item.confidence } : {}),
    ...(item.changeReason && typeof item.changeReason === "object"
      ? { changeReason: asObject(item.changeReason) }
      : {}),
    citations
  };
}
