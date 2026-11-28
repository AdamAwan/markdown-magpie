import { Hono } from "hono";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { can } from "../../auth/capabilities.js";
import { HttpError } from "../../http/errors.js";
import * as service from "./service.js";

export function snapshotRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  // Every flow's latest downloaded snapshot (gaps, in-flight proposals, polled PR
  // state) so a reviewer can see the context the fetch job assembled. A snapshot
  // carries a flow's gaps and draft proposal titles, so the list is filtered to
  // the flows the caller may read; the un-routed/default flow's snapshot needs a
  // "*" read grant (docs/authorization.md AZ31).
  app.get("/", requireScopes("read:knowledge"), async (c) => {
    const snapshots = (await service.listFlowSnapshots(ctx)).filter((snapshot) => can(ctx, c, "read", snapshot.flowId));
    return c.json({ snapshots });
  });

  // One flow's snapshot. The un-routed/default flow is addressed as "default",
  // matching the token its snapshot directory uses. A flow the caller cannot read
  // is a 404, never a 403, so other flows are not enumerable.
  app.get("/:flowId", requireScopes("read:knowledge"), async (c) => {
    const param = c.req.param("flowId");
    const flowId = param === "default" ? undefined : param;
    if (!can(ctx, c, "read", flowId)) {
      throw new HttpError(404, "snapshot_not_found");
    }
    const snapshot = await service.readFlowSnapshot(ctx, flowId);
    if (!snapshot) {
      throw new HttpError(404, "snapshot_not_found");
    }
    return c.json({ snapshot });
  });

  return app;
}
