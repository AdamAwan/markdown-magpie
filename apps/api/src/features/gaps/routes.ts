import { Hono } from "hono";
import type { AppContext } from "../../context.js";
import { parseLimit } from "../../platform/paths.js";
import * as gapsService from "./service.js";

export function gapRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/candidates", async (c) => {
    const limit = parseLimit(c.req.query("limit") ?? null, 50);
    return c.json({ gaps: await gapsService.listCandidates(ctx, limit) });
  });

  app.get("/clusters", async (c) => {
    const limit = parseLimit(c.req.query("limit") ?? null, 50);
    return c.json({ clusters: await gapsService.listClusters(ctx, limit) });
  });

  // Manually draft a proposal for one persisted cluster. The body is optional;
  // targetPath/destinationId override the flow's defaults when supplied.
  app.post("/clusters/:id/proposal", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as {
      targetPath?: unknown;
      destinationId?: unknown;
    };
    const outcome = await gapsService.draftFromCluster(ctx, id, {
      targetPath: typeof body.targetPath === "string" ? body.targetPath : undefined,
      destinationId: typeof body.destinationId === "string" ? body.destinationId : undefined
    });
    if (!outcome.ok) {
      return c.json({ error: outcome.code }, 404);
    }
    return c.json(outcome);
  });

  return app;
}
