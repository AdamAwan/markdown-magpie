import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFanoutBudget } from "./maintenance-fanout.js";
import { makeTestContext } from "../test-support/context.js";
import type { AppContext } from "../context.js";
import type { InFlightCapacity } from "../jobs/broker.js";
import type { JobType, JobView } from "@magpie/jobs";

// A valid maintenance-class AI input (summarize_gap) the fake broker accepts.
function summarizeGapInput() {
  return { provider: "codex", questions: ["q"], citedSections: [], expectedOutput: "gap_summary" } as const;
}

describe("createFanoutBudget", () => {
  it("counts down the per-tick budget and defers with budget_exhausted after N successes", async () => {
    const ctx = makeTestContext();
    ctx.settings.rateLimit.maintenanceMaxAiJobsPerTick = 2;
    const budget = createFanoutBudget(ctx, "correctness_patrol", "flow-a");

    const first = await budget.admit("summarize_gap", summarizeGapInput());
    const second = await budget.admit("summarize_gap", summarizeGapInput());
    const third = await budget.admit("summarize_gap", summarizeGapInput());

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(third.ok, false);
    assert.equal(third.ok === false && third.reason, "budget_exhausted");

    const snapshot = budget.snapshot();
    assert.equal(snapshot.attempted, 3);
    assert.equal(snapshot.enqueued, 2);
    assert.equal(snapshot.deferredByBudget, 1);
    assert.equal(snapshot.rejectedByCapacity, 0);
    // Only the two admitted jobs actually reached the broker.
    const { total } = await ctx.jobs.list({ type: "summarize_gap" });
    assert.equal(total, 2);
  });

  it("returns capacity when the broker's createIfAdmitted rejects, without spending the budget", async () => {
    const ctx = makeTestContext();
    ctx.settings.rateLimit.maintenanceMaxAiJobsPerTick = 5;
    // Force the atomic admission to reject regardless of the local budget.
    let admitCalls = 0;
    ctx.jobs.createIfAdmitted = async (_type: JobType, _input: unknown, _capacity: InFlightCapacity) => {
      admitCalls += 1;
      return { admitted: false, inFlight: 99 };
    };
    const budget = createFanoutBudget(ctx, "editorial_patrol", undefined);

    const result = await budget.admit("summarize_gap", summarizeGapInput());
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "capacity");
    assert.equal(admitCalls, 1);

    const snapshot = budget.snapshot();
    assert.equal(snapshot.attempted, 1);
    assert.equal(snapshot.enqueued, 0);
    assert.equal(snapshot.rejectedByCapacity, 1);
    assert.equal(snapshot.deferredByBudget, 0);
    // The local budget was NOT consumed by a capacity rejection: a later admit
    // (were capacity to free up) would still have room.
    assert.equal(snapshot.budget, 5);
  });

  it("passes through to plain create when rate limiting is disabled (only the budget applies)", async () => {
    const ctx = makeTestContext();
    ctx.settings.rateLimit.enabled = false;
    ctx.settings.rateLimit.maintenanceMaxAiJobsPerTick = 1;
    // createIfAdmitted must never be called on the pass-through path.
    ctx.jobs.createIfAdmitted = async () => {
      throw new Error("createIfAdmitted must not be called when rate limiting is disabled");
    };
    const budget = createFanoutBudget(ctx, "source_change_sync", undefined);

    const first = await budget.admit("summarize_gap", summarizeGapInput());
    const second = await budget.admit("summarize_gap", summarizeGapInput());
    assert.equal(first.ok, true);
    // Even with limiting off, the per-tick budget of 1 still bounds fan-out.
    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.reason, "budget_exhausted");
    const { total } = await ctx.jobs.list({ type: "summarize_gap" });
    assert.equal(total, 1);
  });

  it("finish emits maintenance_fanout with correct counters and flags runaway past the threshold", async () => {
    const ctx = makeTestContext();
    ctx.settings.rateLimit.maintenanceMaxAiJobsPerTick = 1;
    ctx.settings.rateLimit.maintenanceFanoutAlertDeferred = 2;
    const budget = createFanoutBudget(ctx, "correctness_patrol", "flow-b");

    // 1 enqueued, then 2 deferred by budget → 2 shed >= threshold of 2 → runaway.
    await budget.admit("summarize_gap", summarizeGapInput());
    await budget.admit("summarize_gap", summarizeGapInput());
    await budget.admit("summarize_gap", summarizeGapInput());

    const snapshot = budget.snapshot();
    assert.equal(snapshot.attempted, 3);
    assert.equal(snapshot.enqueued, 1);
    assert.equal(snapshot.deferredByBudget, 2);
    assert.equal(snapshot.runaway, true);
    // finish() must not throw and returns void.
    assert.equal(budget.finish(), undefined);
  });

  it("does not flag runaway below the alert threshold", async () => {
    const ctx = makeTestContext();
    ctx.settings.rateLimit.maintenanceMaxAiJobsPerTick = 1;
    ctx.settings.rateLimit.maintenanceFanoutAlertDeferred = 5;
    const budget = createFanoutBudget(ctx, "correctness_patrol", undefined);
    await budget.admit("summarize_gap", summarizeGapInput());
    await budget.admit("summarize_gap", summarizeGapInput()); // 1 deferred < 5
    assert.equal(budget.snapshot().runaway, false);
  });

  it("admitted jobs are real JobViews from the broker", async () => {
    const ctx: AppContext = makeTestContext();
    const budget = createFanoutBudget(ctx, "correctness_patrol", undefined);
    const result = await budget.admit("summarize_gap", summarizeGapInput());
    assert.equal(result.ok, true);
    if (result.ok) {
      const job: JobView = result.job;
      assert.equal(job.type, "summarize_gap");
      assert.ok(await ctx.jobs.get(job.id));
    }
  });
});
