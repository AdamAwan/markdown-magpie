// Outbound HTTP helper shared by the embedding and chat providers.
//
// A bare `fetch` to a model/embeddings endpoint has no timeout, so a hung or
// unresponsive provider stalls indexing or answering indefinitely (and holds
// the request thread). `fetchWithTimeout` binds an AbortSignal so the
// underlying connection is actually torn down — not just abandoned — and turns
// the resulting AbortError into a readable message.
//
// Defaults can be overridden by the caller (the API reads env overrides at its
// composition root); the package itself stays free of runtime/node globals.

export const DEFAULT_EMBEDDING_TIMEOUT_MS = 60_000;
export const DEFAULT_CHAT_TIMEOUT_MS = 120_000;

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
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}
