import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import type { Principal } from "@magpie/auth";
import { makeTestContext } from "../../test-support/context.js";
import type { AppContext } from "../../context.js";
import { onError } from "../../http/errors.js";
import { logger } from "../../logger.js";
import { proposalRoutes } from "./routes.js";

// Body validation runs before capability evaluation, so oversized per-item
// strings on the draft-from-gaps arrays are rejected with 400 rather than being
// bounded only by the global 4 MB body cap and persisted downstream (#293).

function principal(): Principal {
  return { subject: "auth0|tester", scopes: ["read:knowledge", "manage:knowledge"], roles: ["*"], payload: {} };
}

function appFor(ctx: AppContext): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authRequired", true);
    c.set("principal", principal());
    c.set("logger", logger);
    await next();
  });
  app.route("/proposals", proposalRoutes(ctx));
  app.onError(onError);
  return app;
}

async function postFromGaps(app: Hono, body: unknown): Promise<Response> {
  return app.request("/proposals/from-gaps", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("draft-from-gaps input bounds", () => {
  it("rejects an oversized gap summary with 400", async () => {
    const res = await postFromGaps(appFor(makeTestContext()), { summaries: ["x".repeat(2001)] });
    assert.equal(res.status, 400);
  });

  it("rejects an oversized summaries array with 400", async () => {
    const summaries = Array.from({ length: 201 }, (_, i) => `gap ${i}`);
    const res = await postFromGaps(appFor(makeTestContext()), { summaries });
    assert.equal(res.status, 400);
  });

  it("rejects an oversized targetPath with 400", async () => {
    const res = await postFromGaps(appFor(makeTestContext()), {
      summary: "a gap",
      targetPath: `${"deep/".repeat(300)}file.md`
    });
    assert.equal(res.status, 400);
  });

  it("lets a within-bounds request past validation (no 400)", async () => {
    // Downstream flow/destination wiring may still 404 in this bare context; the
    // point here is only that the bounds don't reject a legitimately-sized body.
    const res = await postFromGaps(appFor(makeTestContext()), { summary: "a real gap summary" });
    assert.notEqual(res.status, 400);
  });
});
