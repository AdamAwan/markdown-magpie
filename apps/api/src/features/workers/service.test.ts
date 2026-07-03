import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTestContext } from "../../test-support/context.js";
import { listWatchers, uncoveredJobTypes } from "./service.js";

describe("workers coverage", () => {
  it("reports no gap when the fleet covers every capability", async () => {
    const ctx = makeTestContext();
    await ctx.stores.watchers.touch({
      name: "w1",
      status: "idle",
      capabilities: ["openai-compatible", "github", "local-git", "maintenance"]
    });
    assert.deepEqual(uncoveredJobTypes(await listWatchers(ctx)), []);
  });

  it("marks provider and github work uncovered for a local-git+maintenance fleet, but not publish_proposal", async () => {
    const ctx = makeTestContext();
    await ctx.stores.watchers.touch({ name: "w1", status: "idle", capabilities: ["local-git", "maintenance"] });

    const gap = uncoveredJobTypes(await listWatchers(ctx));
    assert.ok(gap.includes("answer_question"), "no AI provider → generative work is uncovered");
    assert.ok(gap.includes("crosslink_pull_requests"), "no github → crosslink is uncovered");
    // local-git alone covers publish_proposal (it fans out over github OR local-git).
    assert.ok(!gap.includes("publish_proposal"), "local-git covers publish_proposal");
  });

  it("treats an empty fleet as covering nothing", async () => {
    const ctx = makeTestContext();
    const gap = uncoveredJobTypes(await listWatchers(ctx));
    assert.ok(gap.includes("publish_proposal"));
    assert.ok(gap.includes("answer_question"));
  });
});
