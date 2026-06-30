import { Hono } from "hono";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { parseLimit } from "../../platform/paths.js";

// No service.ts: the one endpoint is a trivial pass-through read — parse the limit
// (an HTTP-edge concern that belongs in the route) and hand it to the store. There
// is no orchestration, multi-store assembly, or business rule for a service to own,
// so adding one would be indirection without substance.
export function reconciliationRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  // The reconciler's recent clustering decisions (merges/splits) with the model's
  // rationale and the critic's verdict — most recent first, across all flows.
  app.get("/", requireScopes("read:knowledge"), async (c) => {
    const limit = parseLimit(c.req.query("limit") ?? null, 50);
    return c.json({ decisions: await ctx.stores.reconciliations.list(limit) });
  });

  return app;
}
