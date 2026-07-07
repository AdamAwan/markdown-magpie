import { Hono } from "hono";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";

// How many entries per source are injected into a source-grounded prompt: the
// most-recently-updated 100. The stored cap is higher (see the write path);
// this read cap keeps the prompt block bounded.
const PROMPT_ENTRY_LIMIT = 100;

// Watcher-only scoped-context callback: the source-map hints for the sources a
// source-grounded job is grounded in. Internal navigation metadata — this data
// must never be served on the ask/answer path or any user-facing surface.
export function sourceMapRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/", requireScopes("manage:jobs"), async (c) => {
    const raw = c.req.query("sourceIds") ?? "";
    const sourceIds = [...new Set(raw.split(",").map((id) => id.trim()).filter(Boolean))];
    if (sourceIds.length === 0) {
      return c.json({ error: "source_ids_required" }, 400);
    }
    const lists = await Promise.all(
      sourceIds.map((id) => ctx.stores.sourceMap.listBySource(id, PROMPT_ENTRY_LIMIT))
    );
    return c.json({ entries: lists.flat() });
  });

  return app;
}
