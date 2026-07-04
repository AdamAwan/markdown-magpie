import { Hono } from "hono";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";

// Serves the shared source-corpus snapshots the watcher resolves while running a
// patrol job (#163 Part 2). Read-only: the corpus is written by the API's patrol
// tick, and the watcher fetches it by content hash so the material is not copied
// by value into every job in the batch.
export function sourceCorpusRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/:hash", requireScopes("read:knowledge"), async (c) => {
    const corpus = await ctx.stores.sourceCorpus.get(c.req.param("hash"));
    if (!corpus) {
      // Unknown or pruned hash. A live job should never hit this (its snapshot is
      // saved before enqueue and retained well past job completion), so surface it
      // as a 404 the watcher logs rather than treating absence as an empty corpus.
      return c.json({ error: "source_corpus_not_found" }, 404);
    }
    return c.json({ corpus });
  });

  return app;
}
