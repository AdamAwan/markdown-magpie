import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertAiCapacity } from "./ai-capacity.js";
import { HttpError } from "../http/errors.js";
import { makeTestContext } from "../test-support/context.js";
import type { AppContext } from "../context.js";

// Enqueues a valid in-flight AI job (state "created") so countInFlight sees it.
function enqueueAiJob(ctx: AppContext): Promise<unknown> {
  return ctx.jobs.create("answer_question", {
    provider: "codex",
    question: "q",
    flows: [],
    expectedOutput: "answer_result"
  });
}

describe("assertAiCapacity", () => {
  it("resolves while in-flight AI jobs are below the ceiling", async () => {
    const ctx = makeTestContext();
    ctx.settings.rateLimit.aiMaxInflightJobs = 2;

    await assertAiCapacity(ctx); // 0 in flight
    await enqueueAiJob(ctx);
    await assertAiCapacity(ctx); // 1 < 2
  });

  it("rejects with a 429 ai_capacity error once the ceiling is reached", async () => {
    const ctx = makeTestContext();
    ctx.settings.rateLimit.aiMaxInflightJobs = 2;

    await enqueueAiJob(ctx);
    await enqueueAiJob(ctx); // now 2 in flight, at the cap

    await assert.rejects(
      () => assertAiCapacity(ctx),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 429);
        assert.equal(error.code, "ai_capacity");
        assert.ok(error.headers?.["Retry-After"], "carries a Retry-After header");
        return true;
      }
    );
  });

  it("is a pass-through when rate limiting is disabled", async () => {
    const ctx = makeTestContext();
    ctx.settings.rateLimit.enabled = false;
    ctx.settings.rateLimit.aiMaxInflightJobs = 1;

    await enqueueAiJob(ctx);
    await enqueueAiJob(ctx);
    await assertAiCapacity(ctx); // would exceed the cap, but limiting is off
  });

  it("does not count non-AI jobs toward the ceiling", async () => {
    const ctx = makeTestContext();
    ctx.settings.rateLimit.aiMaxInflightJobs = 1;

    // A completed/other-type job must not occupy AI capacity: enqueue an AI job
    // then complete it, leaving zero in flight.
    const job = await enqueueAiJob(ctx);
    await ctx.jobs.complete((job as { id: string }).id, { answer: "", confidence: "low", citations: [], gaps: [] });
    await assertAiCapacity(ctx); // completed job is not in flight
  });
});
