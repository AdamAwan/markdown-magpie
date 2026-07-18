import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertAiCapacity } from "./ai-capacity.js";
import { HttpError } from "../http/errors.js";
import { makeTestContext } from "../test-support/context.js";
import type { AppContext } from "../context.js";

// Enqueues a valid in-flight interactive AI job (state "created") so
// countInFlight sees it.
function enqueueInteractiveJob(ctx: AppContext): Promise<unknown> {
  return ctx.jobs.create("answer_question", {
    provider: "codex",
    question: "q",
    flows: [],
    expectedOutput: "answer_result"
  });
}

// Enqueues a valid in-flight maintenance-class AI job — counted toward the
// global ceiling but never toward the interactive reserve.
function enqueueMaintenanceJob(ctx: AppContext): Promise<unknown> {
  return ctx.jobs.create("summarize_gap", {
    provider: "codex",
    questions: ["q"],
    citedSections: [],
    expectedOutput: "gap_summary"
  });
}

// Enqueues a valid in-flight questionnaire-batch AI job (#288c) — metered/counted
// toward the global ceiling like any AI job, but NON-interactive, so it never
// counts toward the interactive reserve. Reuses the answer contract.
function enqueueBatchJob(ctx: AppContext): Promise<unknown> {
  return ctx.jobs.create("answer_question_batch", {
    provider: "codex",
    question: "q",
    flows: [],
    expectedOutput: "answer_result"
  });
}

function assertBlocked(ctx: AppContext): Promise<void> {
  return assert.rejects(
    () => assertAiCapacity(ctx),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 429);
      assert.equal(error.code, "ai_capacity");
      assert.ok(error.headers?.["Retry-After"], "carries a Retry-After header");
      return true;
    }
  );
}

describe("assertAiCapacity", () => {
  it("resolves while in-flight AI jobs are below the ceiling", async () => {
    const ctx = makeTestContext();
    ctx.settings.rateLimit.aiMaxInflightJobs = 2;
    ctx.settings.rateLimit.aiInteractiveReservedJobs = 0;

    await assertAiCapacity(ctx); // 0 in flight
    await enqueueInteractiveJob(ctx);
    await assertAiCapacity(ctx); // 1 < 2
  });

  it("rejects with a 429 ai_capacity error once the ceiling is reached", async () => {
    const ctx = makeTestContext();
    ctx.settings.rateLimit.aiMaxInflightJobs = 2;
    ctx.settings.rateLimit.aiInteractiveReservedJobs = 0;

    await enqueueInteractiveJob(ctx);
    await enqueueInteractiveJob(ctx); // now 2 in flight, at the cap

    await assertBlocked(ctx);
  });

  it("keeps admitting interactive work when maintenance fan-out saturates the ceiling", async () => {
    const ctx = makeTestContext();
    ctx.settings.rateLimit.aiMaxInflightJobs = 2;
    ctx.settings.rateLimit.aiInteractiveReservedJobs = 1;

    // A patrol-style burst fills (and here exceeds) the global ceiling…
    await enqueueMaintenanceJob(ctx);
    await enqueueMaintenanceJob(ctx);
    await enqueueMaintenanceJob(ctx);
    // …but the interactive reserve is untouched, so an ask is still admitted.
    await assertAiCapacity(ctx);

    // Once the reserve is occupied too, the next ask is shed.
    await enqueueInteractiveJob(ctx);
    await assertBlocked(ctx);
  });

  it("lets interactive work exceed the reserve while the global ceiling has room", async () => {
    const ctx = makeTestContext();
    ctx.settings.rateLimit.aiMaxInflightJobs = 3;
    ctx.settings.rateLimit.aiInteractiveReservedJobs = 1;

    await enqueueInteractiveJob(ctx);
    await enqueueInteractiveJob(ctx);
    // 2 interactive >= reserve of 1, but total 2 < ceiling of 3.
    await assertAiCapacity(ctx);

    await enqueueMaintenanceJob(ctx); // total now 3, at the ceiling
    await assertBlocked(ctx);
  });

  it("clamps a reserve configured above the ceiling so admission stays bounded", async () => {
    const ctx = makeTestContext();
    ctx.settings.rateLimit.aiMaxInflightJobs = 2;
    ctx.settings.rateLimit.aiInteractiveReservedJobs = 10;

    await enqueueInteractiveJob(ctx);
    await enqueueInteractiveJob(ctx); // at the ceiling; unclamped reserve would still admit

    await assertBlocked(ctx);
  });

  it("a questionnaire batch cannot 429 a live ask via the interactive reserve (#288c acceptance)", async () => {
    const ctx = makeTestContext();
    ctx.settings.rateLimit.aiMaxInflightJobs = 6;
    ctx.settings.rateLimit.aiInteractiveReservedJobs = 5;

    // Two 3-item questionnaire batches fill the global ceiling…
    for (let i = 0; i < 6; i += 1) {
      await enqueueBatchJob(ctx);
    }
    // …but they are answer_question_batch (non-interactive), so interactiveInFlight
    // is 0 < reserve and a live /api/ask is STILL admitted. On pre-#288c code these
    // were answer_question (interactive) and would have occupied the reserve, 429-ing
    // the ask. This assertion fails on pre-#288c code — the acceptance regression.
    await assertAiCapacity(ctx);
  });

  it("five live asks with the global ceiling full still 429 (control for #288c)", async () => {
    const ctx = makeTestContext();
    ctx.settings.rateLimit.aiMaxInflightJobs = 6;
    ctx.settings.rateLimit.aiInteractiveReservedJobs = 5;

    // The reserve genuinely fills with live interactive asks, and a batch tops the
    // global ceiling off — so the sixth live ask is correctly shed. This proves the
    // batch reclassification did not simply disable admission control.
    for (let i = 0; i < 5; i += 1) {
      await enqueueInteractiveJob(ctx);
    }
    await enqueueBatchJob(ctx); // global now 6 (full); reserve holds 5 interactive
    await assertBlocked(ctx);
  });

  it("is a pass-through when rate limiting is disabled", async () => {
    const ctx = makeTestContext();
    ctx.settings.rateLimit.enabled = false;
    ctx.settings.rateLimit.aiMaxInflightJobs = 1;
    ctx.settings.rateLimit.aiInteractiveReservedJobs = 0;

    await enqueueInteractiveJob(ctx);
    await enqueueInteractiveJob(ctx);
    await assertAiCapacity(ctx); // would exceed the cap, but limiting is off
  });

  it("does not count non-AI jobs toward the ceiling", async () => {
    const ctx = makeTestContext();
    ctx.settings.rateLimit.aiMaxInflightJobs = 1;
    ctx.settings.rateLimit.aiInteractiveReservedJobs = 0;

    // A completed/other-type job must not occupy AI capacity: enqueue an AI job
    // then complete it, leaving zero in flight.
    const job = await enqueueInteractiveJob(ctx);
    await ctx.jobs.complete((job as { id: string }).id, { answer: "", confidence: "low", citations: [], gaps: [] });
    await assertAiCapacity(ctx); // completed job is not in flight
  });
});
