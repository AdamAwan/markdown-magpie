import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
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

  // Hono's request validator (zValidator's "json" target) throws an HTTPException
  // for a body that is present but unparseable — before any schema hook runs. Left
  // alone it would fall through to the generic 500 below; surface it as our standard
  // 400 { error: code } shape instead so malformed bodies fail consistently.
  if (error instanceof HTTPException) {
    return c.json({ error: "invalid_json" }, error.status);
  }

  // Log the raw message server-side for diagnostics, but never leak internal
  // error details to clients — return a generic body for non-HttpError 500s.
  const message = error instanceof Error ? error.message : "Unexpected error";
  console.error("Unhandled error:", message);
  return c.json({ error: "internal_error" }, 500);
}
