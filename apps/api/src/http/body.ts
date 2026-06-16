import type { Context } from "hono";

// Reads and parses the request JSON body, falling back to an empty object when
// the body is absent or invalid. This preserves the legacy readJsonBody
// behaviour where an empty body deserialised to `{}` and every field was treated
// as optional. The generic must describe a type whose properties are all
// optional so the empty-object fallback is a valid value of that type.
export async function readJsonBody<T extends object>(c: Context): Promise<T> {
  return c.req.json<T>().catch((): T => ({}) as T);
}
