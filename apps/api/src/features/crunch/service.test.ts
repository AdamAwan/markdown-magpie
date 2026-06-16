import { test } from "node:test";
import assert from "node:assert/strict";
import type { CrunchPlan } from "@magpie/core";
import { makeTestContext } from "../../test-support/context.js";
import { changesetFromPlan, triggerCrunchRun } from "./service.js";

test("triggerCrunchRun in direct+mock mode returns a completed run with a plan", async () => {
  const ctx = makeTestContext();

  const run = await triggerCrunchRun(ctx, { trigger: "manual" });

  assert.equal(run.status, "completed");
  assert.ok(run.plan, "a completed run should carry a plan");
  assert.equal(run.trigger, "manual");
});

test("changesetFromPlan applies deletes then writes with last-write-wins per path", async () => {
  const plan: CrunchPlan = {
    summary: "tidy",
    operations: [
      {
        kind: "split",
        title: "delete a.md",
        reason: "r",
        sources: ["a.md"],
        writes: [],
        deletes: ["a.md"]
      },
      {
        kind: "rewrite",
        title: "rewrite a.md",
        reason: "r",
        sources: ["a.md"],
        writes: [{ path: "a.md", content: "# A\nrewritten" }],
        deletes: []
      }
    ],
    rationale: "r"
  };

  const changes = changesetFromPlan(plan);

  const forA = changes.filter((change) => change.path === "a.md");
  assert.equal(forA.length, 1, "a path deleted then written collapses to a single entry");
  assert.equal(forA[0].content, "# A\nrewritten");
  assert.equal(forA[0].delete, undefined, "the surviving entry is a write, not a delete");
});
