import type { Context } from "hono";
import type { ZodType, infer as ZodInfer } from "zod";
import { HttpError } from "./errors.js";

// Reads the request JSON body. An absent/empty body deserialises to `{}` (every
// field optional, matching the legacy behaviour), but a body that is *present
// yet unparseable* is a client error — surfaced as 400 invalid_json rather than
// silently swallowed into `{}`, which used to hide malformed requests behind
// misleading downstream "field required" errors.
async function readRawJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON.");
  }
}

export async function readJsonBody<T extends object>(c: Context): Promise<T> {
  return (await readRawJson(c)) as T;
}

// Reads the body and validates it against a zod schema, throwing 400 with the
// given code on a shape mismatch. Unlike a bare readJsonBody<T> cast (erased at
// runtime), this actually verifies arrays are arrays etc. before the handler
// iterates/spreads them.
export async function parseJsonBody<S extends ZodType>(
  c: Context,
  schema: S,
  errorCode: string
): Promise<ZodInfer<S>> {
  const result = schema.safeParse(await readRawJson(c));
  if (!result.success) {
    throw new HttpError(400, errorCode);
  }
  return result.data;
}
