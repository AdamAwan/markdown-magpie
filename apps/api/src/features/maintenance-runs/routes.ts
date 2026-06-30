import { Hono } from "hono";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { parseLimit } from "../../platform/paths.js";
import type { MaintenanceTaskType } from "@magpie/core";

// The maintenance task types a run can belong to. Used to validate the optional
// ?taskType filter so an unknown value is ignored rather than passed through.
const TASK_TYPES = new Set<MaintenanceTaskType>(["correctness_patrol", "editorial_patrol", "process_gaps_to_pull_requests"]);

// Read-only run history for the scheduled maintenance tasks, surfaced on the
// Schedules page. Newest-first; optional taskType/flowId filters.
//
// No service.ts: the one endpoint normalizes its query params (limit, a
// set-validated taskType, a trimmed flowId) and makes a single store call. That
// normalization is HTTP-edge work that belongs in the route, and what remains is a
// pass-through read — a service would only forward the same arguments, so none is
// warranted.
export function maintenanceRunRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/", requireScopes("read:knowledge"), async (c) => {
    const limit = parseLimit(c.req.query("limit") ?? null, 30);
    const rawType = c.req.query("taskType");
    const taskType = rawType && TASK_TYPES.has(rawType as MaintenanceTaskType) ? (rawType as MaintenanceTaskType) : undefined;
    const flowId = c.req.query("flowId")?.trim() || undefined;
    return c.json({ runs: await ctx.stores.maintenanceRuns.list({ taskType, flowId, limit }) });
  });

  return app;
}
