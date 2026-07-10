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
  return path.startsWith("/api/") || path === "/api" ? `${resolveApiBaseUrl()}${path}` : `${resolveApiBaseUrl()}/api${path}`;
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

// Combine the caller's signal (if any) with a request timeout so either source
// can abort the fetch. AbortSignal.any short-circuits if the caller already
// aborted, so a superseded request never fires.
function requestSignal({ signal, timeoutMs = DEFAULT_TIMEOUT_MS }: ApiRequestOptions): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  // The error body is not guaranteed to be JSON (proxies and crashes can return
  // HTML or plain text), so parse defensively and fall back to the raw text.
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = {};
    }
  }

  if (!response.ok) {
    const message = (body as { message?: unknown }).message;
    throw new Error(typeof message === "string" ? message : text || response.statusText);
  }

  return body as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected console error";
}
