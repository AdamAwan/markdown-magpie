import type { ApiTokenProvider } from "@magpie/auth";
import type { AiExecutionIdentity, AiUsage, SectionChangeContext, SourceMapEntry } from "@magpie/core";
import type { JobCapability, JobError, JobView } from "@magpie/jobs";
import type { Logger } from "@magpie/logger";
import type { EmbeddingRoute, RoutableFlow } from "@magpie/retrieval";

// Everything the worker loop needs from the API's durable job lifecycle. Kept as
// an interface so the loop and runners can be tested against a fake without
// touching the network.
// The claim a lifecycle call is about: the job id plus the retryCount it was
// claimed at, which names the attempt (docs/ai-jobs.md J60). The API fences
// heartbeat/complete/fail to that attempt, so a watcher whose claim lapsed can
// never refresh, complete or fail an attempt another watcher now holds. A
// claimed JobView satisfies it.
export type ClaimedJob = Pick<JobView, "id" | "retryCount">;

// What a heartbeat reports. `active: false` means this attempt no longer holds
// the job (cancelled, failed, completed, or re-queued after the claim lapsed):
// abort the run and report nothing further. `active` is absent only from an API
// predating J60 (and test fakes), which is read as "still held".
export interface HeartbeatReply {
  cancelled: boolean;
  active?: boolean;
}

export interface WatcherApiClient {
  claim(workerName: string, capabilities: JobCapability[]): Promise<JobView | undefined>;
  heartbeat(job: ClaimedJob): Promise<HeartbeatReply>;
  // `usage` is the run's summed provider-reported token usage (#241), omitted
  // when the provider reported nothing; the API persists it on the completion
  // envelope for the Insights AI-usage chart. `identity` is the executing
  // runner's provider + configured model, omitted for non-AI runners; the API
  // persists it beside usage so token spend can be priced per model.
  complete(job: ClaimedJob, output: unknown, usage?: AiUsage, identity?: AiExecutionIdentity): Promise<void>;
  fail(job: ClaimedJob, error: JobError): Promise<void>;
}

// A retrieved section as returned by POST /api/retrieve. Mirrors the API's
// RetrievedSection shape; the answer runner cites against these.
export interface RetrievedSection {
  sectionId: string;
  documentId: string;
  anchor: string;
  path: string;
  heading: string;
  content: string;
  relevance: number;
  // The newest knowledge-change-log entry for this section, when the log has one.
  // Attached by the API at retrieval time (never ranked on) so the answer prompt
  // can state when a cited section last changed; absent means the log has nothing
  // for it and the answer says nothing about its age.
  lastChanged?: SectionChangeContext;
}

// The full POST /api/retrieve response. `retrievalMode` tells the caller
// whether the sections behind this answer came from hybrid (vector + keyword)
// or keyword-only search, so an empty result can be framed as a lexical miss
// rather than evidence of absence in keyword mode. `candidateCount` is the
// match count BEFORE the relevance floor, so the caller can distinguish
// "nothing matched" from "matches existed but were filtered".
export interface RetrieveResponse {
  sections: RetrievedSection[];
  retrievalMode: "hybrid" | "keyword";
  candidateCount: number;
}

// The credential-free execution context the publication runners fetch before
// running git. The repository fields are exactly the subset the API exposes.
export interface ProposalExecutionContext {
  proposal: unknown;
  repository: unknown;
}

// One of a flow's open pull requests as returned by GET /api/proposals?status=pr-opened,
// reduced to exactly what the refresh runner needs: the proposal id and the PR URL to poll.
export interface OpenPullRequestRef {
  proposalId: string;
  pullRequestUrl: string;
  // The destination's PAT env var NAME when it overrides the host default, so the
  // refresh runner polls a repo held by a different account with its own token.
  tokenEnv?: string;
}

// The full surface the runners and loop use. The loop only needs WatcherApiClient;
// runners additionally use the retrieve + execution-context calls.
export interface WatcherApi extends WatcherApiClient {
  retrieve(
    question: string,
    flowId: string | undefined,
    limit: number | undefined,
    signal?: AbortSignal
  ): Promise<RetrieveResponse>;
  // Cheap embedding-similarity flow routing (POST /api/route). Returns a confident
  // flow or an abstention; a transport/parse failure also resolves to `abstain`, so
  // the caller can uniformly fall back to the chat router. Never throws — routing
  // must never fail the ask.
  routeByEmbedding(question: string, flows: RoutableFlow[], signal?: AbortSignal): Promise<EmbeddingRoute>;
  proposalExecutionContext(proposalId: string): Promise<ProposalExecutionContext>;
  // Drives a flow's gap→PR reconciliation in the API (clustering, then either
  // drafting + publication enqueue, or — when the cluster set needs re-judging —
  // enqueueing the reshape AI job, whose completion drafts). The API returns
  // without waiting on any job. An absent flowId reconciles the default flow.
  reconcileGaps(flowId: string | undefined, signal?: AbortSignal): Promise<{ ok: true }>;
  // Starts (or resumes) post-merge gap-closure verification in the API for a
  // merged proposal: the API enqueues an answer_question re-ask per triggering
  // question and returns at once (`closureStatus: "pending"`); each re-ask's
  // completion resumes the verification, which runs the deterministic closure
  // test and resolves or reopens the gaps. Returns the API's result; the runner
  // passes it through unchanged (schema-validated).
  verifyClosure(proposalId: string, signal?: AbortSignal): Promise<unknown>;
  // Drives source-change sync in the API (checkout/diff/candidate gather + an
  // enqueue of the generative plan job, whose completion finishes the run),
  // returning the run ids created. An absent flowId watches every configured git source.
  runSourceSync(flowId: string | undefined, signal?: AbortSignal): Promise<{ runIds: string[] }>;
  // Drives a fix-patrol tick in the API (select the next batch of documents,
  // enqueue a verify_document check for each, advance the cursor), returning the
  // run id, how many were selected, and how many verifies are still to answer.
  // The API returns at once — each verify's completion applies its own verdict.
  // An absent flowId patrols the default flow.
  runFixPatrol(
    flowId: string | undefined,
    signal?: AbortSignal
  ): Promise<{ runId: string; selectedCount: number; findingCount: number; pendingVerifyCount?: number }>;
  // Drives an improve-patrol tick in the API (select the next batch on the improve
  // cursor + enqueue one improve_document scan per selected document + advance the
  // cursor), returning the run id, how many were selected, and how many scans were
  // enqueued. An absent flowId patrols the default flow.
  runImprovePatrol(
    flowId: string | undefined,
    signal?: AbortSignal
  ): Promise<{ runId: string; selectedCount: number; enqueuedCount: number }>;
  // Drives a sparse-flow seed-bootstrap tick in the API: guard checks + (when
  // they pass) an enqueue of an auto-origin outline_flow_seed job. The API
  // returns immediately — like every orchestration call, it never waits on the job.
  runSeedBootstrap(
    flowId: string,
    signal?: AbortSignal
  ): Promise<{ enqueued: boolean; reason?: string; outlineJobId?: string }>;
  // The flow's currently open pull requests with a PR URL to poll. Used by the
  // github-capability refresh runner, which holds the GitHub credentials the API
  // no longer does.
  listOpenPullRequests(signal?: AbortSignal): Promise<OpenPullRequestRef[]>;
  // The source-map hints for the given sources (GET /api/source-map). Callers
  // treat this as best-effort optional context — see fetchSourceMapEntries.
  sourceMapEntries(sourceIds: string[]): Promise<SourceMapEntry[]>;
}

export interface HttpClientOptions {
  apiBaseUrl: string;
  workerName: string;
  // Resolves the bearer token for the API's scope-protected routes, when
  // configured. Called per-request so a client-credentials token is refreshed
  // transparently before it expires; returns undefined when auth is disabled
  // (no Authorization header is then sent).
  token?: ApiTokenProvider;
  // Per-request abort deadline for the hot-path calls (claim/heartbeat/
  // complete/fail/retrieve/…). Kept short so a wedged API can't stall the loop.
  requestTimeoutMs?: number;
  // Per-request abort deadline for the maintenance *orchestration* calls
  // (reconcileGaps/runSourceSync/runFixPatrol/runImprovePatrol). Those endpoints
  // never wait on the AI jobs they enqueue, but they do real work inline (git
  // checkouts and diffs, embedding/retrieval, PR status polls) that can outlast
  // the hot-path default on a large flow — a 30s cap here would silently abort
  // the call and fail the tick.
  maintenanceTimeoutMs?: number;
  // Logs retried complete()/fail() attempts (see SETTLE_RETRY_* below).
  // Defaults to a no-op so tests and callers that don't care can omit it.
  logger?: Logger;
  // Override the complete()/fail() retry schedule (see SETTLE_RETRY_* below);
  // exposed so tests aren't stuck waiting out the real production backoff.
  settleRetry?: Partial<SettleRetryPolicy>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAINTENANCE_TIMEOUT_MS = 15 * 60_000;
// A heartbeat is tiny; a slow one must not eat the claim's margin. With the
// catalog's 120s heartbeat window and a 30s beat (worker-loop.ts), a 10s cap
// keeps three consecutive lost beats survivable (J60).
const HEARTBEAT_TIMEOUT_MS = 10_000;

// A non-2xx HTTP response, carrying the status so callers can tell a transient
// server failure (5xx) or a network/timeout error (no status at all — see below)
// apart from a deterministic contract failure (4xx) that retrying can never fix.
class HttpRequestStatusError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "HttpRequestStatusError";
  }
}

// The finished provider output is only ever sitting in the runner's memory once —
// if the complete() POST itself fails on a network blip or a transient 5xx (the
// API mid-restart or mid-deploy, a load balancer hiccup), the caller's only
// recourse used to be falling back to fail(), which discards that output and
// forces pg-boss to redo the entire (paid-for) generation. complete() is
// idempotent on the API side (see completeJob in
// apps/api/src/features/jobs/service.ts), so it is retried for MINUTES — long
// enough to ride out an API restart or a rolling deploy — not the ~2s it used to
// be (J61). The worker loop keeps heartbeating meanwhile, so the claim does not
// lapse while the API is reachable; if it does lapse while the API is down, the
// API still salvages this attempt's completion from the job's own retry.
//
// This retry also doubles as the automatic recovery path for the API's `500
// side_effects_failed` response: the API persists the job's output BEFORE its
// side-effect fan-out, so a re-POST on that 5xx replays only the side effects —
// never the generation. fail() rides the same schedule: a 5xx there means the
// API could not record the failure (or settle its side effects) yet.
//
// Only transient answers are retried: a network error/timeout, a 5xx, 408 or 429.
// Every other 4xx is a permanent verdict no retry can change — 400 invalid
// output (or a repair already enqueued), 404 unknown job, 409 cancelled / no
// longer held by this attempt — and is thrown at once.
export interface SettleRetryPolicy {
  // First backoff delay; each retry doubles it up to maxDelayMs, full-jittered.
  baseDelayMs: number;
  maxDelayMs: number;
  // Give up once the next attempt would start later than this after the first.
  budgetMs: number;
}

const SETTLE_RETRY_POLICY: SettleRetryPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  budgetMs: 8 * 60_000
};

function isRetryableSettleError(error: unknown): boolean {
  if (!(error instanceof HttpRequestStatusError)) return true;
  return error.status >= 500 || error.status === 408 || error.status === 429;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The watcher's only conduit to the API. It owns the URL shapes and the worker
// identity that the API records on terminal transitions (so a failed/completed
// job's diagnostics show which executor handled it).
export class HttpWatcherApi implements WatcherApi {
  private readonly base: string;
  private readonly workerName: string;
  private readonly token?: ApiTokenProvider;
  private readonly timeoutMs: number;
  private readonly maintenanceTimeoutMs: number;
  private readonly logger?: Logger;
  private readonly settleRetry: SettleRetryPolicy;

  constructor(options: HttpClientOptions) {
    this.base = trimTrailingSlash(options.apiBaseUrl).replace(/\/api$/, "");
    this.workerName = options.workerName;
    this.token = options.token;
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maintenanceTimeoutMs = options.maintenanceTimeoutMs ?? DEFAULT_MAINTENANCE_TIMEOUT_MS;
    this.logger = options.logger;
    this.settleRetry = { ...SETTLE_RETRY_POLICY, ...options.settleRetry };
  }

  async claim(workerName: string, capabilities: JobCapability[]): Promise<JobView | undefined> {
    const { job } = await this.post<{ job: JobView | null }>("/api/jobs/claim", { workerName, capabilities });
    return job ?? undefined;
  }

  async heartbeat(job: ClaimedJob): Promise<HeartbeatReply> {
    // Send the worker name so the API keeps this watcher marked busy on the job
    // it is running (the registry behind the Jobs screen's connected-workers
    // view), and the claimed attempt so the API answers for THIS claim.
    const reply = await this.post<{ cancelled?: boolean; active?: boolean }>(
      `/api/jobs/${job.id}/heartbeat`,
      { workerName: this.workerName, attempt: job.retryCount },
      undefined,
      HEARTBEAT_TIMEOUT_MS
    );
    return { cancelled: Boolean(reply.cancelled), active: reply.active !== false };
  }

  async complete(job: ClaimedJob, output: unknown, usage?: AiUsage, identity?: AiExecutionIdentity): Promise<void> {
    // The output is only ever held in the runner's memory, so a dropped response
    // here must not fall straight through to worker-loop's fail() fallback (which
    // would discard it and force a full paid-for regeneration) when the failure
    // is transient. Retry locally first; see SETTLE_RETRY_POLICY above.
    await this.settleWithRetry(job.id, "completion", () =>
      this.post(`/api/jobs/${job.id}/complete`, {
        output,
        executor: this.workerName,
        attempt: job.retryCount,
        ...(usage ? { usage } : {}),
        ...(identity ? { provider: identity.provider } : {}),
        ...(identity?.model ? { model: identity.model } : {})
      })
    );
  }

  async fail(job: ClaimedJob, error: JobError): Promise<void> {
    // Stamp the executor so terminal diagnostics record who handled the job.
    // Retried like complete(): a 5xx means the API could not record the failure
    // yet, and a dropped fail() would leave the job to expire instead (API31).
    await this.settleWithRetry(job.id, "failure", () =>
      this.post(`/api/jobs/${job.id}/fail`, {
        error: { ...error, executor: this.workerName },
        attempt: job.retryCount
      })
    );
  }

  // Runs one terminal-transition POST under SETTLE_RETRY_POLICY: retry transient
  // failures with full-jittered exponential backoff until the budget is spent,
  // throw a permanent one (or the last transient one) to the caller.
  private async settleWithRetry(jobId: string, what: string, send: () => Promise<unknown>): Promise<void> {
    const { baseDelayMs, maxDelayMs, budgetMs } = this.settleRetry;
    const startedAt = Date.now();
    for (let retry = 0; ; retry += 1) {
      try {
        await send();
        return;
      } catch (error) {
        const ceilingMs = Math.min(maxDelayMs, baseDelayMs * 2 ** retry);
        // Full jitter over the upper half keeps a fleet that lost the API at the
        // same moment from re-POSTing in lockstep when it returns.
        const delayMs = Math.round(ceilingMs / 2 + Math.random() * (ceilingMs / 2));
        if (!isRetryableSettleError(error) || Date.now() - startedAt + delayMs > budgetMs) {
          throw error;
        }
        this.logger?.warn(
          { jobId, retry: retry + 1, delayMs, err: error instanceof Error ? error.message : String(error) },
          `job ${what} POST failed; retrying`
        );
        await sleep(delayMs);
      }
    }
  }

  async retrieve(
    question: string,
    flowId: string | undefined,
    limit: number | undefined,
    signal?: AbortSignal
  ): Promise<RetrieveResponse> {
    const body = await this.post<Partial<RetrieveResponse>>(
      "/api/retrieve",
      {
        question,
        ...(flowId ? { flowId } : {}),
        ...(limit ? { limit } : {})
      },
      signal
    );
    const sections = body.sections ?? [];
    return {
      sections,
      // Default to "hybrid" so an API predating these fields cannot silently
      // switch the watcher into the weaker-evidence framing.
      retrievalMode: body.retrievalMode ?? "hybrid",
      candidateCount: body.candidateCount ?? sections.length
    };
  }

  async routeByEmbedding(question: string, flows: RoutableFlow[], signal?: AbortSignal): Promise<EmbeddingRoute> {
    try {
      return await this.post<EmbeddingRoute>("/api/route", { question, flows }, signal);
    } catch (error) {
      // Routing must never fail the ask: on a transport/parse error, abstain so the
      // caller falls back to the chat router (the pre-existing behaviour).
      this.logger?.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "embedding route call failed; abstaining to the chat router"
      );
      return { status: "abstain" };
    }
  }

  async reconcileGaps(flowId: string | undefined, signal?: AbortSignal): Promise<{ ok: true }> {
    await this.post("/api/gaps/reconcile", { ...(flowId ? { flowId } : {}) }, signal, this.maintenanceTimeoutMs);
    return { ok: true };
  }

  async verifyClosure(proposalId: string, signal?: AbortSignal): Promise<unknown> {
    return this.post(`/api/proposals/${proposalId}/verify-closure`, {}, signal, this.maintenanceTimeoutMs);
  }

  async runSourceSync(flowId: string | undefined, signal?: AbortSignal): Promise<{ runIds: string[] }> {
    const { runIds } = await this.post<{ runIds: string[] }>(
      "/api/source-sync/run",
      { ...(flowId ? { flowId } : {}) },
      signal,
      this.maintenanceTimeoutMs
    );
    return { runIds };
  }

  async runFixPatrol(
    flowId: string | undefined,
    signal?: AbortSignal
  ): Promise<{ runId: string; selectedCount: number; findingCount: number; pendingVerifyCount?: number }> {
    return this.post<{ runId: string; selectedCount: number; findingCount: number; pendingVerifyCount?: number }>(
      "/api/fix-patrol/run",
      { ...(flowId ? { flowId } : {}) },
      signal,
      this.maintenanceTimeoutMs
    );
  }

  async runImprovePatrol(
    flowId: string | undefined,
    signal?: AbortSignal
  ): Promise<{ runId: string; selectedCount: number; enqueuedCount: number }> {
    return this.post<{ runId: string; selectedCount: number; enqueuedCount: number }>(
      "/api/fix-patrol/improve/run",
      { ...(flowId ? { flowId } : {}) },
      signal,
      this.maintenanceTimeoutMs
    );
  }

  async runSeedBootstrap(
    flowId: string,
    signal?: AbortSignal
  ): Promise<{ enqueued: boolean; reason?: string; outlineJobId?: string }> {
    return this.post<{ enqueued: boolean; reason?: string; outlineJobId?: string }>(
      `/api/flows/${encodeURIComponent(flowId)}/seed-bootstrap/run`,
      {},
      signal,
      this.maintenanceTimeoutMs
    );
  }

  async listOpenPullRequests(signal?: AbortSignal): Promise<OpenPullRequestRef[]> {
    const { proposals } = await this.get<{
      proposals: Array<{ id: string; publication?: { pullRequestUrl?: string }; destinationTokenEnv?: string }>;
    }>("/api/proposals?status=pr-opened", signal);
    return proposals.flatMap((proposal) => {
      const pullRequestUrl = proposal.publication?.pullRequestUrl;
      return pullRequestUrl
        ? [
            {
              proposalId: proposal.id,
              pullRequestUrl,
              ...(proposal.destinationTokenEnv ? { tokenEnv: proposal.destinationTokenEnv } : {})
            }
          ]
        : [];
    });
  }

  async proposalExecutionContext(proposalId: string): Promise<ProposalExecutionContext> {
    return this.get<ProposalExecutionContext>(`/api/proposals/${proposalId}/execution-context`);
  }

  async sourceMapEntries(sourceIds: string[]): Promise<SourceMapEntry[]> {
    const { entries } = await this.get<{ entries: SourceMapEntry[] }>(
      `/api/source-map?sourceIds=${encodeURIComponent(sourceIds.join(","))}`
    );
    return entries;
  }

  private async post<TResponse>(
    path: string,
    body: unknown,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<TResponse> {
    return this.request<TResponse>(path, { method: "POST", body: JSON.stringify(body) }, signal, timeoutMs);
  }

  private async get<TResponse>(path: string, signal?: AbortSignal): Promise<TResponse> {
    return this.request<TResponse>(path, { method: "GET" }, signal);
  }

  private async request<TResponse>(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<TResponse> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = this.token ? await this.token() : undefined;
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }
    // The W3C traceparent that continues the job's trace onto this callback is
    // injected by OpenTelemetry's undici auto-instrumentation when telemetry is
    // enabled, so no correlation header is set by hand here.
    // Abort on the request timeout, or sooner if the caller's signal (a job
    // cancellation / watcher shutdown) fires first. Long-running orchestration
    // calls pass a larger deadline; everything else uses the hot-path default.
    const effectiveTimeoutMs = timeoutMs ?? this.timeoutMs;
    const timeout = AbortSignal.timeout(effectiveTimeoutMs);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        ...init,
        headers,
        signal: combined
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new Error(`${init.method ?? "GET"} ${path} timed out after ${effectiveTimeoutMs}ms`, {
          cause: error
        });
      }
      throw error;
    }
    if (!response.ok) {
      throw new HttpRequestStatusError(
        `${init.method ?? "GET"} ${path} failed with ${response.status}: ${await response.text()}`,
        response.status
      );
    }
    return (await response.json()) as TResponse;
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
