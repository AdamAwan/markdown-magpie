import type { JobCapability, JobError, JobView } from "@magpie/jobs";

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
}

// The credential-free execution context the publication runners fetch before
// running git. The repository fields are exactly the subset the API exposes.
export interface ProposalExecutionContext {
  proposal: unknown;
  repository: unknown;
}

export interface CrunchExecutionContext {
  run: unknown;
  repository: unknown;
}

export interface SourceSyncExecutionContext {
  run: unknown;
  sourceName: unknown;
  repository: unknown;
}

// The full surface the runners and loop use. The loop only needs WatcherApiClient;
// runners additionally use the retrieve + execution-context calls.
export interface WatcherApi extends WatcherApiClient {
  retrieve(question: string, flowId: string | undefined, limit: number | undefined): Promise<RetrievedSection[]>;
  proposalExecutionContext(proposalId: string): Promise<ProposalExecutionContext>;
  crunchExecutionContext(runId: string): Promise<CrunchExecutionContext>;
  sourceSyncExecutionContext(runId: string): Promise<SourceSyncExecutionContext>;
  // Drives a flow's gap→PR reconciliation in the API (clustering, the reshape AI
  // job the API bounded-waits on, drafting and publication enqueue). An absent
  // flowId reconciles the default flow.
  reconcileGaps(flowId: string | undefined, signal?: AbortSignal): Promise<{ ok: true }>;
  // Drives source-change sync in the API (checkout/diff/candidate gather + the
  // generative plan job the API bounded-waits on + publication enqueue), returning
  // the run ids created. An absent flowId watches every configured git source.
  runSourceSync(flowId: string | undefined, signal?: AbortSignal): Promise<{ runIds: string[] }>;
}

export interface HttpClientOptions {
  apiBaseUrl: string;
  workerName: string;
  // Bearer token for the API's scope-protected routes, when configured.
  apiToken?: string;
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

// The watcher's only conduit to the API. It owns the URL shapes and the worker
// identity that the API records on terminal transitions (so a failed/completed
// job's diagnostics show which executor handled it).
export class HttpWatcherApi implements WatcherApi {
  private readonly base: string;
  private readonly workerName: string;
  private readonly apiToken?: string;
  private readonly timeoutMs: number;

  constructor(options: HttpClientOptions) {
    this.base = trimTrailingSlash(options.apiBaseUrl).replace(/\/api$/, "");
    this.workerName = options.workerName;
    this.apiToken = options.apiToken;
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async claim(workerName: string, capabilities: JobCapability[]): Promise<JobView | undefined> {
    const { job } = await this.post<{ job: JobView | null }>("/api/jobs/claim", { workerName, capabilities });
    return job ?? undefined;
  }

  async heartbeat(jobId: string): Promise<{ cancelled: boolean }> {
    const { cancelled } = await this.post<{ cancelled: boolean }>(`/api/jobs/${jobId}/heartbeat`, {});
    return { cancelled: Boolean(cancelled) };
  }

  async complete(jobId: string, output: unknown): Promise<void> {
    await this.post(`/api/jobs/${jobId}/complete`, { output, executor: this.workerName });
  }

  async fail(jobId: string, error: JobError): Promise<void> {
    // Stamp the executor so terminal diagnostics record who handled the job.
    await this.post(`/api/jobs/${jobId}/fail`, { error: { ...error, executor: this.workerName } });
  }

  async retrieve(question: string, flowId: string | undefined, limit: number | undefined): Promise<RetrievedSection[]> {
    const { sections } = await this.post<{ sections: RetrievedSection[] }>("/api/retrieve", {
      question,
      ...(flowId ? { flowId } : {}),
      ...(limit ? { limit } : {})
    });
    return sections;
  }

  async reconcileGaps(flowId: string | undefined, signal?: AbortSignal): Promise<{ ok: true }> {
    await this.post("/api/gaps/reconcile", { ...(flowId ? { flowId } : {}) }, signal);
    return { ok: true };
  }

  async runSourceSync(flowId: string | undefined, signal?: AbortSignal): Promise<{ runIds: string[] }> {
    const { runIds } = await this.post<{ runIds: string[] }>(
      "/api/source-sync/run",
      { ...(flowId ? { flowId } : {}) },
      signal
    );
    return { runIds };
  }

  async proposalExecutionContext(proposalId: string): Promise<ProposalExecutionContext> {
    return this.get<ProposalExecutionContext>(`/api/proposals/${proposalId}/execution-context`);
  }

  async crunchExecutionContext(runId: string): Promise<CrunchExecutionContext> {
    return this.get<CrunchExecutionContext>(`/api/crunch/runs/${runId}/execution-context`);
  }

  async sourceSyncExecutionContext(runId: string): Promise<SourceSyncExecutionContext> {
    return this.get<SourceSyncExecutionContext>(`/api/source-sync/runs/${runId}/execution-context`);
  }

  private async post<TResponse>(path: string, body: unknown, signal?: AbortSignal): Promise<TResponse> {
    return this.request<TResponse>(path, { method: "POST", body: JSON.stringify(body) }, signal);
  }

  private async get<TResponse>(path: string): Promise<TResponse> {
    return this.request<TResponse>(path, { method: "GET" });
  }

  private async request<TResponse>(path: string, init: RequestInit, signal?: AbortSignal): Promise<TResponse> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiToken) {
      headers.authorization = `Bearer ${this.apiToken}`;
    }
    // Abort on the request timeout, or sooner if the caller's signal (a job
    // cancellation / watcher shutdown) fires first.
    const timeout = AbortSignal.timeout(this.timeoutMs);
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
        throw new Error(`${init.method ?? "GET"} ${path} timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    }
    if (!response.ok) {
      throw new Error(`${init.method ?? "GET"} ${path} failed with ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as TResponse;
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
