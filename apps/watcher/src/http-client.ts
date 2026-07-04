import type { ApiTokenProvider } from "@magpie/auth";
import type { SourceDataContext } from "@magpie/core";
import type { JobCapability, JobError, JobView } from "@magpie/jobs";
import type { Logger } from "@magpie/logger";
import type { EmbeddingRoute, RoutableFlow } from "@magpie/retrieval";

// Everything the worker loop needs from the API's durable job lifecycle. Kept as
// an interface so the loop and runners can be tested against a fake without
// touching the network.
export interface WatcherApiClient {
  claim(workerName: string, capabilities: JobCapability[]): Promise<JobView | undefined>;
  heartbeat(jobId: string): Promise<{ cancelled: boolean }>;
  complete(jobId: string, output: unknown): Promise<void>;
  fail(jobId: string, error: JobError): Promise<void>;
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
}

// The full surface the runners and loop use. The loop only needs WatcherApiClient;
// runners additionally use the retrieve + execution-context calls.
export interface WatcherApi extends WatcherApiClient {
  retrieve(
    question: string,
    flowId: string | undefined,
    limit: number | undefined,
    signal?: AbortSignal
  ): Promise<RetrievedSection[]>;
  // Cheap embedding-similarity flow routing (POST /api/route). Returns a confident
  // flow or an abstention; a transport/parse failure also resolves to `abstain`, so
  // the caller can uniformly fall back to the chat router. Never throws — routing
  // must never fail the ask.
  routeByEmbedding(question: string, flows: RoutableFlow[], signal?: AbortSignal): Promise<EmbeddingRoute>;
  proposalExecutionContext(proposalId: string): Promise<ProposalExecutionContext>;
  // Drives a flow's gap→PR reconciliation in the API (clustering, the reshape AI
  // job the API bounded-waits on, drafting and publication enqueue). An absent
  // flowId reconciles the default flow.
  reconcileGaps(flowId: string | undefined, signal?: AbortSignal): Promise<{ ok: true }>;
  // Drives post-merge gap-closure verification in the API for a merged proposal:
  // re-asks the triggering questions (enqueued answer_question jobs the API
  // bounded-waits on), runs the deterministic closure test, and resolves or
  // reopens the gaps. Returns the API's closure result; the runner passes it
  // through unchanged (schema-validated).
  verifyClosure(proposalId: string, signal?: AbortSignal): Promise<unknown>;
  // Drives source-change sync in the API (checkout/diff/candidate gather + the
  // generative plan job the API bounded-waits on + publication enqueue), returning
  // the run ids created. An absent flowId watches every configured git source.
  runSourceSync(flowId: string | undefined, signal?: AbortSignal): Promise<{ runIds: string[] }>;
  // Drives a fix-patrol tick in the API (select the next batch of documents to
  // check + advance the cursor), returning the run id and how many were checked.
  // An absent flowId patrols the default flow.
  runFixPatrol(
    flowId: string | undefined,
    signal?: AbortSignal
  ): Promise<{ runId: string; selectedCount: number; findingCount: number }>;
  // Drives an improve-patrol tick in the API (select the next batch on the improve
  // cursor + enqueue one improve_document scan per selected document + advance the
  // cursor), returning the run id, how many were selected, and how many scans were
  // enqueued. An absent flowId patrols the default flow.
  runImprovePatrol(
    flowId: string | undefined,
    signal?: AbortSignal
  ): Promise<{ runId: string; selectedCount: number; enqueuedCount: number }>;
  // The flow's currently open pull requests with a PR URL to poll. Used by the
  // github-capability refresh runner, which holds the GitHub credentials the API
  // no longer does.
  listOpenPullRequests(signal?: AbortSignal): Promise<OpenPullRequestRef[]>;
  // Resolves the shared source corpus a patrol job checks against, by the content
  // hash carried in the job's `sourcesRef` (#163 Part 2). The corpus is identical
  // across every verify/correct/improve job in a tick, so the client caches it by
  // hash and fetches each distinct corpus over the wire at most once.
  getSourceCorpus(hash: string, signal?: AbortSignal): Promise<SourceDataContext[]>;
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
  // bounded-wait inside the API on a batch of AI jobs and legitimately run for
  // minutes — the maintenance job that drives them has a 1-hour budget and is
  // heartbeated throughout — so they need a far longer deadline than the hot-path
  // default (a 30s cap here silently aborts the call and fails the patrol tick).
  maintenanceTimeoutMs?: number;
  // Logs retried complete() attempts (see COMPLETE_RETRY_ATTEMPTS below).
  // Defaults to a no-op so tests and callers that don't care can omit it.
  logger?: Logger;
  // Overrides the base backoff delay between complete() retries. Defaults to
  // COMPLETE_RETRY_BASE_DELAY_MS; exposed so tests aren't stuck waiting out the
  // real production backoff.
  completeRetryBaseDelayMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAINTENANCE_TIMEOUT_MS = 15 * 60_000;

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
// API mid-restart, a load balancer hiccup), the caller's only recourse used to be
// falling back to fail(), which discards that output and forces pg-boss to redo
// the entire (paid-for) generation. complete() is idempotent on the API side (see
// completeJob in apps/api/src/features/jobs/service.ts), so retrying it locally a
// few times is safe and far cheaper than a full regeneration. This retry also
// doubles as the automatic recovery path for the API's `500 side_effects_failed`
// response: the API persists the job's output BEFORE its side-effect fan-out, so
// a re-POST on that 5xx replays only the side effects — never the generation. A
// 4xx (invalid output, job not found, job cancelled) is a deterministic contract
// failure no amount of retrying fixes, so those are not retried here.
const COMPLETE_RETRY_ATTEMPTS = 3;
const COMPLETE_RETRY_BASE_DELAY_MS = 250;

// How many distinct source-corpus snapshots the client keeps cached at once.
// Content-addressed, so a cached corpus is never stale; the cap only bounds memory
// on a long-lived watcher. A handful covers the corpus versions in flight across
// concurrent flows/ticks; the oldest is evicted past this.
const SOURCE_CORPUS_CACHE_MAX = 16;

function isRetryableCompleteError(error: unknown): boolean {
  return !(error instanceof HttpRequestStatusError) || error.status >= 500;
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
  private readonly completeRetryBaseDelayMs: number;
  // Per-hash cache of resolved source corpora (see getSourceCorpus). Map iteration
  // order is insertion order, so the first key is the oldest for FIFO eviction.
  private readonly sourceCorpusCache = new Map<string, SourceDataContext[]>();

  constructor(options: HttpClientOptions) {
    this.base = trimTrailingSlash(options.apiBaseUrl).replace(/\/api$/, "");
    this.workerName = options.workerName;
    this.token = options.token;
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maintenanceTimeoutMs = options.maintenanceTimeoutMs ?? DEFAULT_MAINTENANCE_TIMEOUT_MS;
    this.logger = options.logger;
    this.completeRetryBaseDelayMs = options.completeRetryBaseDelayMs ?? COMPLETE_RETRY_BASE_DELAY_MS;
  }

  async claim(workerName: string, capabilities: JobCapability[]): Promise<JobView | undefined> {
    const { job } = await this.post<{ job: JobView | null }>("/api/jobs/claim", { workerName, capabilities });
    return job ?? undefined;
  }

  async heartbeat(jobId: string): Promise<{ cancelled: boolean }> {
    // Send the worker name so the API keeps this watcher marked busy on the job
    // it is running (the registry behind the Jobs screen's connected-workers view).
    const { cancelled } = await this.post<{ cancelled: boolean }>(`/api/jobs/${jobId}/heartbeat`, {
      workerName: this.workerName
    });
    return { cancelled: Boolean(cancelled) };
  }

  async complete(jobId: string, output: unknown): Promise<void> {
    // The output is only ever held in the runner's memory, so a dropped response
    // here must not fall straight through to worker-loop's fail() fallback (which
    // would discard it and force a full paid-for regeneration) when the failure
    // is transient. Retry locally first; see COMPLETE_RETRY_ATTEMPTS above.
    let attempt = 0;
    for (;;) {
      try {
        await this.post(`/api/jobs/${jobId}/complete`, { output, executor: this.workerName });
        return;
      } catch (error) {
        if (attempt >= COMPLETE_RETRY_ATTEMPTS || !isRetryableCompleteError(error)) {
          throw error;
        }
        attempt += 1;
        const delayMs = this.completeRetryBaseDelayMs * 2 ** (attempt - 1);
        this.logger?.warn(
          { jobId, attempt, delayMs, err: error instanceof Error ? error.message : String(error) },
          "job completion POST failed; retrying before falling back to failing the job"
        );
        await sleep(delayMs);
      }
    }
  }

  async fail(jobId: string, error: JobError): Promise<void> {
    // Stamp the executor so terminal diagnostics record who handled the job.
    await this.post(`/api/jobs/${jobId}/fail`, { error: { ...error, executor: this.workerName } });
  }

  async retrieve(
    question: string,
    flowId: string | undefined,
    limit: number | undefined,
    signal?: AbortSignal
  ): Promise<RetrievedSection[]> {
    const { sections } = await this.post<{ sections: RetrievedSection[] }>(
      "/api/retrieve",
      {
        question,
        ...(flowId ? { flowId } : {}),
        ...(limit ? { limit } : {})
      },
      signal
    );
    return sections;
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
  ): Promise<{ runId: string; selectedCount: number; findingCount: number }> {
    return this.post<{ runId: string; selectedCount: number; findingCount: number }>(
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

  async listOpenPullRequests(signal?: AbortSignal): Promise<OpenPullRequestRef[]> {
    const { proposals } = await this.get<{
      proposals: Array<{ id: string; publication?: { pullRequestUrl?: string } }>;
    }>("/api/proposals?status=pr-opened", signal);
    return proposals.flatMap((proposal) => {
      const pullRequestUrl = proposal.publication?.pullRequestUrl;
      return pullRequestUrl ? [{ proposalId: proposal.id, pullRequestUrl }] : [];
    });
  }

  async proposalExecutionContext(proposalId: string): Promise<ProposalExecutionContext> {
    return this.get<ProposalExecutionContext>(`/api/proposals/${proposalId}/execution-context`);
  }

  async getSourceCorpus(hash: string, signal?: AbortSignal): Promise<SourceDataContext[]> {
    const cached = this.sourceCorpusCache.get(hash);
    if (cached) {
      return cached;
    }
    const { corpus } = await this.get<{ corpus: SourceDataContext[] }>(`/api/source-corpus/${hash}`, signal);
    this.sourceCorpusCache.set(hash, corpus);
    if (this.sourceCorpusCache.size > SOURCE_CORPUS_CACHE_MAX) {
      const oldest = this.sourceCorpusCache.keys().next().value;
      if (oldest !== undefined) {
        this.sourceCorpusCache.delete(oldest);
      }
    }
    return corpus;
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
