// A route-table stand-in for the Magpie API, installed over `globalThis.fetch`.
// Tests that mount the real ConsoleProvider (or any component that calls
// lib/api) use it so the production request/response code runs unmodified —
// only the network is fake. Unknown routes answer 404 with a message naming the
// route, so a test that forgets one fails loudly instead of hanging.

export interface FakeRequest {
  method: string;
  /** Path without the `/api` prefix and without the query string, e.g. `/jobs/job-1/cancel`. */
  path: string;
  /** Query string including the leading `?`, or "" when there is none. */
  search: string;
  /** Parsed JSON body; the raw FormData for multipart uploads; undefined when no body was sent. */
  body: unknown;
}

/** Throw from a handler to make the fake API answer with a non-2xx status and a `{ message }` body. */
export class FakeApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** Returns the JSON body to answer with (or a promise of it). */
export type RouteHandler = (request: FakeRequest) => unknown;

export interface FakeApi {
  /** Every request received so far, in arrival order. */
  requests: FakeRequest[];
  /** Requests matching a method and exact path. */
  calls(method: string, path: string): FakeRequest[];
  /** Add or replace a route. `route` is `"METHOD /path"` (no `/api` prefix, no query string). */
  on(route: string, handler: RouteHandler): void;
  /** Number of requests still awaiting a response. */
  pending(): number;
  /** Put the original fetch back. */
  restore(): void;
}

export function installFakeApi(routes: Record<string, RouteHandler> = {}): FakeApi {
  const originalFetch = globalThis.fetch;
  const table = new Map<string, RouteHandler>(Object.entries(routes));
  const requests: FakeRequest[] = [];
  let inFlight = 0;

  async function respond(request: FakeRequest): Promise<Response> {
    const route = `${request.method} ${request.path}`;
    const handler = table.get(route);
    if (!handler) {
      return jsonResponse(404, { message: `No fake route for ${route}` });
    }
    try {
      return jsonResponse(200, await handler(request));
    } catch (error) {
      if (error instanceof FakeApiError) {
        return jsonResponse(error.status, { message: error.message });
      }
      throw error;
    }
  }

  globalThis.fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(requestUrl(input), "http://console.test");
    const request: FakeRequest = {
      method: (init.method ?? "GET").toUpperCase(),
      path: url.pathname.replace(/^\/api/, ""),
      search: url.search,
      body: typeof init.body === "string" ? JSON.parse(init.body) : (init.body ?? undefined)
    };
    requests.push(request);
    inFlight += 1;
    try {
      const response = await respond(request);
      // Mirror real fetch: a request whose signal aborted while it was in flight
      // rejects rather than delivering its (now stale) response.
      if (init.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return response;
    } finally {
      inFlight -= 1;
    }
  };

  return {
    requests,
    calls: (method, path) => requests.filter((request) => request.method === method && request.path === path),
    on: (route, handler) => {
      table.set(route, handler);
    },
    pending: () => inFlight,
    restore: () => {
      globalThis.fetch = originalFetch;
    }
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body ?? {}), { status, headers: { "content-type": "application/json" } });
}

/** A promise plus its resolver — lets a test hold a fake route open and release it later. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
