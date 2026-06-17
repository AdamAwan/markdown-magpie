const configuredApiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;

declare global {
  interface Window {
    __MAGPIE_CONFIG__?: {
      apiBaseUrl?: string;
    };
  }
}

export function resolveApiBaseUrl(): string {
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

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(resolveApiUrl(path));
  return readResponse<T>(response);
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(resolveApiUrl(path), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return readResponse<T>(response);
}

export async function apiDelete<T>(path: string): Promise<T> {
  const response = await fetch(resolveApiUrl(path), { method: "DELETE" });
  return readResponse<T>(response);
}

async function readResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(typeof body.message === "string" ? body.message : text || response.statusText);
  }

  return body as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected console error";
}
