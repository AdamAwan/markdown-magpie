// Outbound HTTP helpers shared by the embedding and chat providers.
//
// A bare `fetch` to a model/embeddings endpoint has no timeout, so a hung or
// unresponsive provider stalls indexing or answering indefinitely (and holds
// the request thread). `fetchWithTimeout` binds an AbortSignal so the
// underlying connection is actually torn down — not just abandoned — and turns
// the resulting AbortError into a readable, typed error.
//
// Every provider failure surfaces as a ProviderRequestError carrying the HTTP
// status and any Retry-After the provider sent, so callers can tell a 429/5xx
// (worth retrying later) from a 4xx (configuration) without parsing messages.
// The message never carries the raw response body: a provider error body can
// echo the request (prompt text, retrieved content) or credentials, and these
// messages end up in job errors, logs and the console. Only a short, redacted
// summary of it is kept (`describeErrorBody`).
//
// Defaults can be overridden by the caller (the API and watcher read env
// overrides at their composition roots); the package itself stays free of
// runtime/node globals.

// Background (indexing) embedding calls batch many sections, so they keep a
// generous timeout. The request path (query-time retrieval, flow routing) uses
// DEFAULT_QUERY_EMBEDDING_TIMEOUT_MS instead — see query-embedding.ts.
export const DEFAULT_EMBEDDING_TIMEOUT_MS = 60_000;
export const DEFAULT_CHAT_TIMEOUT_MS = 120_000;

// How a provider request failed. `http_status` carries `status`; the others did
// not get a response at all (or, for `circuit_open`, were not attempted).
export type ProviderFailureKind = "http_status" | "timeout" | "network" | "circuit_open";

export interface ProviderRequestErrorDetails {
  // Which provider surface failed ("Chat provider", "Embedding provider").
  label: string;
  kind: ProviderFailureKind;
  status?: number;
  // Parsed from Retry-After / retry-after-ms when the provider sent one.
  retryAfterMs?: number;
}

export class ProviderRequestError extends Error {
  readonly label: string;
  readonly kind: ProviderFailureKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, details: ProviderRequestErrorDetails, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderRequestError";
    this.label = details.label;
    this.kind = details.kind;
    if (details.status !== undefined) {
      this.status = details.status;
    }
    if (details.retryAfterMs !== undefined) {
      this.retryAfterMs = details.retryAfterMs;
    }
  }

  // Transient by construction: rate limiting, a server-side fault, a timeout, or
  // a dropped connection. A 4xx other than 408/429 is a request or configuration
  // problem that a retry would only reproduce; an open circuit is a deliberate
  // fast failure, not something to retry around.
  get retryable(): boolean {
    if (this.kind === "timeout" || this.kind === "network") {
      return true;
    }
    if (this.kind === "http_status" && this.status !== undefined) {
      return this.status === 408 || this.status === 429 || this.status >= 500;
    }
    return false;
  }
}

// The provider stopped generating because it hit its output-token limit
// (OpenAI `finish_reason: "length"`, AI SDK `finishReason: "length"`). The text
// it did return is a prefix of an answer, so it must not be parsed as one: a
// truncated JSON object would otherwise be reported as a schema-invalid output
// (and, for a repairable job, spend a paid repair reshaping half an answer).
export class ProviderOutputTruncatedError extends Error {
  constructor(label: string, detail?: string) {
    super(
      `${label} output was truncated at the model's output-token limit${detail ? ` (${detail})` : ""}; ` +
        "raise the deployment's max output tokens or reduce the job's size"
    );
    this.name = "ProviderOutputTruncatedError";
  }
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
  // Optional caller cancellation, combined with the timeout so either tears the
  // connection down. Used by the watcher to abort a cancelled/shutdown job.
  callerSignal?: AbortSignal
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
  try {
    return await fetch(url, { ...init, signal });
  } catch (error) {
    // A caller cancellation is not a provider failure: let it propagate as-is so
    // the caller sees its own abort reason, and nothing retries it.
    if (callerSignal?.aborted) {
      throw error;
    }
    if (timeoutSignal.aborted) {
      throw new ProviderRequestError(
        `${label} timed out after ${timeoutMs}ms`,
        { label, kind: "timeout" },
        {
          cause: error
        }
      );
    }
    // undici reports DNS/connect/reset failures as a TypeError("fetch failed")
    // whose cause names the errno; keep the cause, not the host details, in the
    // message.
    throw new ProviderRequestError(
      `${label} request failed: ${networkReason(error)}`,
      { label, kind: "network" },
      {
        cause: error
      }
    );
  }
}

function networkReason(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof Error && "code" in cause && typeof cause.code === "string") {
    return cause.code;
  }
  return "network error";
}

// Throws a ProviderRequestError for a non-2xx response, with the status, the
// provider's Retry-After, and a short redacted summary of the body.
export async function assertProviderResponseOk(response: Response, label: string): Promise<void> {
  if (response.ok) {
    return;
  }
  const retryAfterMs = parseRetryAfterMs(response.headers);
  const detail = describeErrorBody(await response.text().catch(() => ""));
  throw new ProviderRequestError(`${label} failed with ${response.status}${detail ? `: ${detail}` : ""}`, {
    label,
    kind: "http_status",
    status: response.status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs })
  });
}

// Retry-After is either delta-seconds or an HTTP-date (RFC 9110 §10.2.3);
// Azure/OpenAI also send a millisecond `retry-after-ms`, which wins when present.
export function parseRetryAfterMs(headers: Headers, nowMs: number = Date.now()): number | undefined {
  const millis = headers.get("retry-after-ms");
  if (millis !== null && /^\d+(?:\.\d+)?$/.test(millis.trim())) {
    return Math.round(Number(millis.trim()));
  }
  const value = headers.get("retry-after")?.trim();
  if (!value) {
    return undefined;
  }
  if (/^\d+$/.test(value)) {
    return Number(value) * 1000;
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}

const MAX_ERROR_DETAIL_CHARS = 300;

// A provider error body, reduced to something safe to put in an error message:
// the provider's own `error.message` when it sent OpenAI-style JSON, otherwise
// the text itself; whitespace collapsed, credential-shaped tokens redacted, and
// capped at MAX_ERROR_DETAIL_CHARS. Never the whole body — it can echo the
// request's prompt or retrieved content.
export function describeErrorBody(body: string): string {
  const collapsed = (jsonErrorMessage(body) ?? body).replace(/\s+/g, " ").trim();
  const redacted = redactSecrets(collapsed);
  return redacted.length > MAX_ERROR_DETAIL_CHARS ? `${redacted.slice(0, MAX_ERROR_DETAIL_CHARS)}…` : redacted;
}

function jsonErrorMessage(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  if ("error" in parsed) {
    const inner = parsed.error;
    if (typeof inner === "string") {
      return inner;
    }
    if (typeof inner === "object" && inner !== null && "message" in inner && typeof inner.message === "string") {
      return inner.message;
    }
  }
  if ("message" in parsed && typeof parsed.message === "string") {
    return parsed.message;
  }
  return undefined;
}

// Credential-shaped substrings a gateway might echo back: OpenAI-style `sk-…`
// keys, bearer tokens, and `key=value` pairs whose key names a secret.
function redactSecrets(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /\b(api[-_]?key|access[-_]?token|token|secret|password)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
      "$1$2[redacted]"
    );
}

export interface RetryPolicy {
  // Retries AFTER the first attempt; 0 disables retrying.
  maxRetries: number;
  // Exponential backoff base: attempt n waits about baseDelayMs * 2^n.
  baseDelayMs: number;
  // Longest single wait. A provider Retry-After beyond this is not waited out —
  // the error propagates (with its retryAfterMs) for the job-level retry instead.
  maxDelayMs: number;
}

export const DEFAULT_CHAT_RETRY_POLICY: RetryPolicy = { maxRetries: 2, baseDelayMs: 1_000, maxDelayMs: 30_000 };

export interface RetryHooks {
  // Test seam for the wait between attempts (default: an abortable timer).
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  // Test seam for jitter, in [0, 1). Default Math.random.
  random?: () => number;
  // Observes each retry decision (the composition root logs it).
  onRetry?: (event: { attempt: number; delayMs: number; error: ProviderRequestError }) => void;
}

// Runs `attempt` and retries a retryable ProviderRequestError with bounded
// exponential backoff (jittered, honouring the provider's Retry-After). Stops
// immediately when the caller's signal aborts — during a wait too.
export async function withProviderRetry<T>(
  attempt: () => Promise<T>,
  policy: RetryPolicy,
  signal?: AbortSignal,
  hooks: RetryHooks = {}
): Promise<T> {
  const sleep = hooks.sleep ?? abortableSleep;
  const random = hooks.random ?? Math.random;
  for (let retry = 0; ; retry += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof ProviderRequestError) || !error.retryable || retry >= policy.maxRetries) {
        throw error;
      }
      if (signal?.aborted) {
        throw error;
      }
      const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** retry);
      // Equal jitter: half fixed, half random, so concurrent watchers spread out
      // without ever retrying immediately.
      const jittered = Math.round(backoff / 2 + (backoff / 2) * random());
      if (error.retryAfterMs !== undefined && error.retryAfterMs > policy.maxDelayMs) {
        throw error;
      }
      const delayMs = Math.max(error.retryAfterMs ?? 0, jittered);
      hooks.onRetry?.({ attempt: retry + 1, delayMs, error });
      await sleep(delayMs, signal);
    }
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
