import { Hono } from "hono";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { HttpError } from "../../http/errors.js";
import * as service from "./service.js";

export function snapshotRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  // Every flow's latest downloaded snapshot (gaps, in-flight proposals, polled PR
  // state) so a reviewer can see the context the fetch job assembled.
  app.get("/", requireScopes("read:knowledge"), async (c) => {
    return c.json({ snapshots: await service.listFlowSnapshots(ctx) });
  });

  // One flow's snapshot. The un-routed/default flow is addressed as "default",
  // matching the token its snapshot directory uses.
  app.get("/:flowId", requireScopes("read:knowledge"), async (c) => {
    const param = c.req.param("flowId");
    const flowId = param === "default" ? undefined : param;
    const snapshot = await service.readFlowSnapshot(ctx, flowId);
    if (!snapshot) {
      throw new HttpError(404, "snapshot_not_found");
    }
    return c.json({ snapshot });
  });

  return app;
}
