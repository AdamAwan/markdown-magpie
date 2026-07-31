import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { assertCan, can } from "../../auth/capabilities.js";
import { parseLimit } from "../../platform/paths.js";
import type { SourceConflict } from "../../stores/source-conflict-store.js";

// There is deliberately no route to RESOLVE a conflict by hand. Resolution is
// evidence-based — the verify agent reports that the sources now agree — because
// a human marking it resolved would be Magpie asserting an agreement that does
// not exist in the sources. A reviewer who thinks a conflict is not real
// dismisses it instead.
const patchBodySchema = z.object({
  status: z.literal("dismissed"),
  note: z.string().max(2000).optional()
});

const STATUSES = ["open", "resolved", "dismissed"] as const;

function parseStatus(value: string | undefined): SourceConflict["status"] | undefined {
  return STATUSES.find((status) => status === value);
}

export function sourceConflictRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/", requireScopes("read:knowledge"), async (c) => {
    const limit = parseLimit(c.req.query("limit") ?? null, 50);
    const flowId = c.req.query("flowId") ?? undefined;
    const status = parseStatus(c.req.query("status") ?? undefined);
    // Flow-scoped read: a role-aware principal only sees conflicts for flows it
    // can read. Filters rather than 403s, matching the proposals list.
    const conflicts = (await ctx.stores.sourceConflicts.list({ flowId, status, limit })).filter((conflict) =>
      can(ctx, c, "read", conflict.flowId)
    );
    return c.json({ conflicts });
  });

  app.patch(
    "/:id",
    requireScopes("manage:knowledge"),
    zValidator("json", patchBodySchema, (result, c) => {
      if (!result.success) {
        // A resolve attempt lands here: only "dismissed" is accepted.
        return c.json({ error: "invalid_status" }, 400);
      }
      return undefined;
    }),
    async (c) => {
      const id = c.req.param("id");
      const conflict = await ctx.stores.sourceConflicts.get(id);
      // A conflict in a flow the principal cannot read reads as absent, not
      // forbidden — a 403 would confirm the id exists (docs/authorization.md).
      if (!conflict || !can(ctx, c, "read", conflict.flowId)) {
        return c.json({ error: "not_found" }, 404);
      }
      assertCan(ctx, c, "manage", conflict.flowId);
      const { note } = c.req.valid("json");
      const updated = await ctx.stores.sourceConflicts.dismiss(id, note ?? "");
      if (!updated) {
        return c.json({ error: "not_found" }, 404);
      }
      return c.json(updated);
    }
  );

  return app;
}
