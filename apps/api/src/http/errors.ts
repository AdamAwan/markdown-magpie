import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export class HttpError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: string,
    message?: string
  ) {
    super(message ?? code);
  }
}

export function onError(error: Error, c: Context): Response {
  if (error instanceof HttpError) {
    const body =
      error.message && error.message !== error.code
        ? { error: error.code, message: error.message }
        : { error: error.code };
    return c.json(body, error.status);
  }

  const message = error instanceof Error ? error.message : "Unexpected error";
  return c.json({ error: "internal_error", message }, 500);
}
