import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import type { Principal } from "@magpie/auth";
import { makeTestContext } from "../../test-support/context.js";
import type { AppContext } from "../../context.js";
import { onError } from "../../http/errors.js";
import { proposalRoutes } from "./routes.js";

// Regression coverage for issue #153: POST /proposals/:id/status is a plain
// unconditional write (updateStatus doesn't no-op on a repeated status), so a
// retried or double-clicked "mark merged" request must not run the merge
// cascade — and therefore enqueue verify_gap_closure — a second time. A second
// enqueue would re-run the (expensive, LLM-backed) closure re-asks and could
// double-count a still-open verdict against CLOSURE_RETRY_CAP.

function principal(): Principal {
  return { subject: "auth0|tester", scopes: ["read:knowledge", "manage:knowledge"], roles: undefined, payload: {} };
}

function appFor(ctx: AppContext): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authRequired", true);
    c.set("principal", principal());
    await next();
  });
  app.route("/proposals", proposalRoutes(ctx));
  app.onError(onError);
  return app;
}

// A branch-pushed proposal (no pull request to poll) with a triggering
// question, so a merge actually has a gap to verify — the case runMergeCascade
// enqueues verify_gap_closure for.
async function seedBranchPushedWithGap(ctx: AppContext): Promise<string> {
  const log = await ctx.stores.questionLogs.record({
    question: "How do I configure X?",
    chatProvider: "codex",
    retrievedSectionIds: []
  });
  await ctx.stores.questionLogs.recordManualGap(log.id, "How to configure X");
  const created = await ctx.stores.proposals.create({
    title: "Configure X",
    targetPath: "configure-x.md",
    markdown: "# Configure X\nbody",
    rationale: "r",
    evidence: [],
    gapSummary: "How to configure X",
    triggeringQuestionIds: [log.id]
  });
  await ctx.stores.proposals.recordPublication(created.id, {
    provider: "local-git",
    branchName: "magpie/proposal-configure-x",
    commitSha: "deadbeef",
    publishedAt: new Date().toISOString()
  });
  return created.id;
}

async function postMergedStatus(
  app: Hono,
  id: string
): Promise<{ status: number; body: { proposal?: { status: string }; cascadeScheduled?: boolean } }> {
  const res = await app.request(`/proposals/${id}/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "merged" })
  });
  return {
    status: res.status,
    body: (await res.json()) as { proposal?: { status: string }; cascadeScheduled?: boolean }
  };
}

describe("POST /proposals/:id/status merged→merged idempotency", () => {
  it("only schedules the merge cascade on the first transition into merged", async () => {
    const ctx = makeTestContext();
    const id = await seedBranchPushedWithGap(ctx);
    const app = appFor(ctx);

    const first = await postMergedStatus(app, id);
    assert.equal(first.status, 200);
    assert.equal(first.body.proposal?.status, "merged");
    assert.equal(first.body.cascadeScheduled, true);
    await ctx.background.whenIdle();

    const afterFirst = await ctx.jobs.list({ type: "verify_gap_closure" });
    assert.equal(afterFirst.jobs.length, 1, "the first merge enqueues exactly one verification job");

    // A retried / double-clicked re-POST of the same status.
    const second = await postMergedStatus(app, id);
    assert.equal(second.status, 200);
    assert.equal(second.body.proposal?.status, "merged");
    assert.notEqual(second.body.cascadeScheduled, true, "a repeated merged status must not reschedule the cascade");
    await ctx.background.whenIdle();

    const afterSecond = await ctx.jobs.list({ type: "verify_gap_closure" });
    assert.equal(afterSecond.jobs.length, 1, "the re-POST does not enqueue a second verification job");
  });
});
