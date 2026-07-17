const configuredApiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;

declare global {
  interface Window {
    __MAGPIE_CONFIG__?: {
      apiBaseUrl?: string;
      mcpUrl?: string;
      auth?: {
        domain?: string;
        clientId?: string;
        audience?: string;
        redirectUri?: string;
      };
    };
  }
}

function resolveApiBaseUrl(): string {
  if (configuredApiBaseUrl) {
    return configuredApiBaseUrl.replace(/\/+$/, "").replace(/\/api$/, "");
  }

  if (typeof window !== "undefined" && window.__MAGPIE_CONFIG__?.apiBaseUrl) {
    return window.__MAGPIE_CONFIG__.apiBaseUrl.replace(/\/+$/, "").replace(/\/api$/, "");
  }

  return "";
}

export function resolveApiUrl(path: string): string {
  return path.startsWith("/api/") || path === "/api"
    ? `${resolveApiBaseUrl()}${path}`
    : `${resolveApiBaseUrl()}/api${path}`;
}

// Default per-request timeout. Each call also accepts a caller AbortSignal, which
// is combined with the timeout so either can abort the request.
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ApiRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

// When Auth0 is configured the AuthProvider registers a provider that returns a
// fresh access token. When auth is disabled no provider is set and requests go
// out without an Authorization header, exactly as before.
let accessTokenProvider: (() => Promise<string>) | undefined;

export function setAccessTokenProvider(provider: (() => Promise<string>) | undefined): void {
  accessTokenProvider = provider;
}

async function authHeaders(headers: Record<string, string> = {}): Promise<Record<string, string>> {
  if (!accessTokenProvider) {
    return headers;
  }
  const token = await accessTokenProvider();
  return { ...headers, authorization: `Bearer ${token}` };
}

export async function apiGet<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const response = await fetch(resolveApiUrl(path), {
    headers: await authHeaders(),
    signal: requestSignal(options)
  });
  return readResponse<T>(response);
}

export async function apiPost<T>(path: string, body: unknown, options: ApiRequestOptions = {}): Promise<T> {
  const response = await fetch(resolveApiUrl(path), {
    method: "POST",
    headers: await authHeaders({
      "content-type": "application/json"
    }),
    body: JSON.stringify(body),
    signal: requestSignal(options)
  });
  return readResponse<T>(response);
}

export async function apiPatch<T>(path: string, body: unknown, options: ApiRequestOptions = {}): Promise<T> {
  const response = await fetch(resolveApiUrl(path), {
    method: "PATCH",
    headers: await authHeaders({
      "content-type": "application/json"
    }),
    body: JSON.stringify(body),
    signal: requestSignal(options)
  });
  return readResponse<T>(response);
}

export async function apiDelete<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const response = await fetch(resolveApiUrl(path), {
    method: "DELETE",
    headers: await authHeaders(),
    signal: requestSignal(options)
  });
  return readResponse<T>(response);
}

// Download a file from the API. Unlike an <a href> the browser would navigate to
// directly (which carries no Authorization header and 401s under Auth0), this
// fetches with the same bearer token as every other call, then saves the
// response body via a temporary object-URL anchor. Prefers the filename the
// server sets in Content-Disposition, falling back to `fallbackFilename`.
export async function apiDownload(
  path: string,
  fallbackFilename: string,
  options: ApiRequestOptions = {}
): Promise<void> {
  const response = await fetch(resolveApiUrl(path), {
    headers: await authHeaders(),
    signal: requestSignal(options)
  });
  if (!response.ok) {
    await throwResponseError(response);
  }
  const blob = await response.blob();
  const filename = filenameFromContentDisposition(response.headers.get("content-disposition")) ?? fallbackFilename;
  triggerBrowserDownload(blob, filename);
}

function filenameFromContentDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /filename\*?=(?:UTF-8''|")?([^";]+)"?/i.exec(header);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

// Combine the caller's signal (if any) with a request timeout so either source
// can abort the fetch. AbortSignal.any short-circuits if the caller already
// aborted, so a superseded request never fires.
function requestSignal({ signal, timeoutMs = DEFAULT_TIMEOUT_MS }: ApiRequestOptions): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    await throwResponseError(response);
  }
  const text = await response.text();
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = {};
    }
  }
  return body as T;
}

// Turn a non-ok response into a thrown Error. The error body is not guaranteed
// to be JSON (proxies and crashes can return HTML or plain text), so parse
// defensively and fall back to the raw text or status line.
async function throwResponseError(response: Response): Promise<never> {
  const text = await response.text();
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = {};
    }
  }
  const message = (body as { message?: unknown }).message;
  throw new Error(typeof message === "string" ? message : text || response.statusText);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected console error";
}
