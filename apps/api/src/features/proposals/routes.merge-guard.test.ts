import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import type { Principal } from "@magpie/auth";
import { makeTestContext } from "../../test-support/context.js";
import type { AppContext } from "../../context.js";
import { onError } from "../../http/errors.js";
import { proposalRoutes } from "./routes.js";

// Guards the manual merge action on POST /proposals/:id/status. The pr-opened →
// merged transition is owned by the PR-poll path (refresh_flow_snapshot +
// applyPullRequestTransition), which only flips a proposal to merged once its real
// pull request has merged in git. A proposal with a live PR must not be
// hand-asserted merged here; the manual action stays available only as the no-PR
// fallback (a branch pushed without a pull request, e.g. no GITHUB_TOKEN).

function serviceP(): Principal {
  // A service/M2M principal (no roles claim) passes the flow-scope carve-out, so
  // these tests exercise the merge guard rather than authorization.
  return { subject: "auth0|tester", scopes: ["read:knowledge", "manage:knowledge"], roles: undefined, payload: {} };
}

function appFor(ctx: AppContext): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authRequired", true);
    c.set("principal", serviceP());
    await next();
  });
  app.route("/proposals", proposalRoutes(ctx));
  app.onError(onError);
  return app;
}

async function seedPublished(ctx: AppContext, withPullRequest: boolean): Promise<string> {
  const proposal = await ctx.stores.proposals.create({
    title: "Draft",
    targetPath: "docs/thing.md",
    markdown: "# Thing",
    rationale: "r",
    evidence: []
  });
  // recordPublication derives the status: a pullRequestUrl ⇒ pr-opened, none ⇒
  // branch-pushed. This mirrors exactly what the publish runner records.
  await ctx.stores.proposals.recordPublication(proposal.id, {
    provider: "local-git",
    branchName: "magpie/proposal-x",
    commitSha: "abc1234",
    ...(withPullRequest ? { pullRequestUrl: "https://github.com/acme/kb/pull/7" } : {}),
    publishedAt: new Date().toISOString()
  });
  return proposal.id;
}

describe("proposal status route — manual merge guard", () => {
  it("rejects hand-asserting a pr-opened proposal as merged (poll path owns it)", async () => {
    const ctx = makeTestContext();
    const id = await seedPublished(ctx, true);

    const res = await appFor(ctx).request(`/proposals/${id}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "merged" })
    });

    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "proposal_merge_tracked_by_pull_request");

    // The proposal is untouched: still pr-opened, no merge cascade.
    const after = await ctx.stores.proposals.get(id);
    assert.equal(after?.status, "pr-opened");
    assert.equal(after?.mergedAt, undefined);
  });

  it("allows the branch-pushed fallback (no PR to poll) to be marked merged", async () => {
    const ctx = makeTestContext();
    const id = await seedPublished(ctx, false);

    const res = await appFor(ctx).request(`/proposals/${id}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "merged" })
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { proposal: { status: string }; cascadeScheduled?: boolean };
    assert.equal(body.proposal.status, "merged");
    assert.equal(body.cascadeScheduled, true);
  });

  it("still allows non-merge transitions on a pr-opened proposal", async () => {
    const ctx = makeTestContext();
    const id = await seedPublished(ctx, true);

    const res = await appFor(ctx).request(`/proposals/${id}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "rejected" })
    });

    assert.equal(res.status, 200);
    const after = await ctx.stores.proposals.get(id);
    assert.equal(after?.status, "rejected");
  });
});
