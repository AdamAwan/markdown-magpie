import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { assertCan, can } from "../../auth/capabilities.js";
import { parseLimit } from "../../platform/paths.js";
import type { AssertedClaim } from "../../stores/asserted-claims-store.js";

// The asserted-claims register (questionnaire ingestion,
// docs/superpowers/specs/2026-08-11-questionnaire-ingestion-design.md D6):
// claims we made to customers that our own sources do not support.
//
// Unlike a source conflict, a human CAN resolve one of these, because resolution
// here is a statement about the record rather than about the sources: "I added
// the certificate to the compliance repo", or "that answer was wrong and has
// been withdrawn". Both outcomes are human judgements, so both are offered — and
// both demand a note, because an entry closed without a reason is exactly the
// audit trail this register exists to provide.
const patchBodySchema = z.object({
  status: z.enum(["resolved", "dismissed"]),
  note: z.string().trim().min(1).max(2000)
});

const STATUSES = ["open", "resolved", "dismissed"] as const;

function parseStatus(value: string | undefined): AssertedClaim["status"] | undefined {
  return STATUSES.find((status) => status === value);
}

export function assertedClaimRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/", requireScopes("read:knowledge"), async (c) => {
    const limit = parseLimit(c.req.query("limit") ?? null, 50);
    const flowId = c.req.query("flowId") ?? undefined;
    const status = parseStatus(c.req.query("status") ?? undefined);
    // Flow-scoped read: a role-aware principal only sees findings for flows it
    // can read. Filters rather than 403s, matching the conflict register.
    const claims = (await ctx.stores.assertedClaims.list({ flowId, status, limit })).filter((claim) =>
      can(ctx, c, "read", claim.flowId)
    );
    return c.json({ claims });
  });

  app.patch(
    "/:id",
    requireScopes("manage:knowledge"),
    zValidator("json", patchBodySchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "invalid_asserted_claim_patch" }, 400);
      }
      return undefined;
    }),
    async (c) => {
      const id = c.req.param("id");
      const claim = await ctx.stores.assertedClaims.get(id);
      // A finding in a flow the principal cannot read reads as absent, not
      // forbidden — a 403 would confirm the id exists (docs/authorization.md).
      if (!claim || !can(ctx, c, "read", claim.flowId)) {
        return c.json({ error: "not_found" }, 404);
      }
      assertCan(ctx, c, "manage", claim.flowId);
      const { status, note } = c.req.valid("json");
      const updated =
        status === "resolved"
          ? await ctx.stores.assertedClaims.resolve(id, note)
          : await ctx.stores.assertedClaims.dismiss(id, note);
      if (!updated) {
        return c.json({ error: "not_found" }, 404);
      }
      return c.json(updated);
    }
  );

  return app;
}
