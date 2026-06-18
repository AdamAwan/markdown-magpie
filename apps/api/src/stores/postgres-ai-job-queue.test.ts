import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { AiJobType } from "@magpie/core";
import { PostgresAiJobQueue } from "./postgres-ai-job-queue.js";

// Integration tests for the Postgres-backed AI job queue. They self-skip unless
// DATABASE_URL points at a migrated database (see scripts/migrate.mjs); CI
// provides one via a pgvector service container. Modeled on the
// postgres-proposal-store.test.ts template — round-trip through real SQL and
// assert by the ids you created so parallel rows never make the suite flaky.
//
// claimNext claims the OLDEST pending job table-wide, so tests that need a
// deterministic claim first drain pre-existing pending jobs (see drainPending).
const databaseUrl = process.env.DATABASE_URL;

const ALL_TYPES: AiJobType[] = [
  "answer_question",
  "summarize_gap",
  "draft_markdown_proposal",
  "detect_contradiction",
  "suggest_consolidation",
  "crunch_knowledge_base"
];

describe("PostgresAiJobQueue", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  const queue = new PostgresAiJobQueue(databaseUrl as string);

  // Claim every currently-pending job so a subsequently enqueued job is the only
  // candidate claimNext can return. Bounded so a logic error can't spin forever.
  async function drainPending(): Promise<void> {
    for (let i = 0; i < 1000; i++) {
      const claimed = await queue.claimNext("drain-worker", ALL_TYPES);
      if (!claimed) {
        return;
      }
    }
    throw new Error("drainPending did not converge — more than 1000 pending jobs");
  }

  it("enqueues a job and reads it back via get", async () => {
    const input = { question: "what is markdown?", testId: randomUUID() };

    const enqueued = await queue.enqueue("answer_question", input);
    assert.equal(enqueued.status, "pending");
    assert.deepEqual(enqueued.input, input);

    const fetched = await queue.get(enqueued.id);
    assert.equal(fetched?.id, enqueued.id);
    assert.equal(fetched?.type, "answer_question");
    assert.equal(fetched?.status, "pending");
    assert.deepEqual(fetched?.input, input);
  });

  it("lists enqueued jobs in creation order", async () => {
    const testId = randomUUID();
    const first = await queue.enqueue("answer_question", { question: "first", testId });
    const second = await queue.enqueue("answer_question", { question: "second", testId });

    const ours = (await queue.list()).filter(
      (job) => job.input && typeof job.input === "object" && (job.input as { testId?: string }).testId === testId
    );

    const firstIndex = ours.findIndex((job) => job.id === first.id);
    const secondIndex = ours.findIndex((job) => job.id === second.id);
    assert.ok(firstIndex >= 0, "first job should be in the list");
    assert.ok(secondIndex >= 0, "second job should be in the list");
    assert.ok(firstIndex < secondIndex, "jobs should be ordered by creation time");
  });

  it("claimNext claims the oldest pending job and stamps the worker", async () => {
    await drainPending();
    const enqueued = await queue.enqueue("answer_question", { testId: randomUUID() });

    const claimed = await queue.claimNext("claim-worker", ["answer_question"]);
    assert.equal(claimed?.id, enqueued.id);
    assert.equal(claimed?.status, "claimed");
    assert.equal(claimed?.claimedBy, "claim-worker");
    assert.ok(claimed?.claimedAt);
  });

  it("does not re-offer a claimed job to the next claimant", async () => {
    await drainPending();
    const enqueued = await queue.enqueue("answer_question", { testId: randomUUID() });

    const first = await queue.claimNext("worker-a", ["answer_question"]);
    assert.equal(first?.id, enqueued.id);

    // The only pending job we created is now claimed, so the next claim of the
    // same type must not return it (it returns undefined, with the queue drained).
    const second = await queue.claimNext("worker-b", ["answer_question"]);
    assert.equal(second, undefined);
  });

  it("filters claimNext by accepted job type", async () => {
    await drainPending();
    const summary = await queue.enqueue("summarize_gap", { testId: randomUUID() });
    const answer = await queue.enqueue("answer_question", { testId: randomUUID() });

    // Only summarize_gap is accepted, so the older answer job is skipped.
    const claimed = await queue.claimNext("type-worker", ["summarize_gap"]);
    assert.equal(claimed?.id, summary.id);
    assert.notEqual(claimed?.id, answer.id);
  });

  it("completes a job, recording output and clearing any error", async () => {
    const enqueued = await queue.enqueue("answer_question", { testId: randomUUID() });

    const output = { answer: "markdown is great", confidence: "high", citations: [] };
    await queue.complete(enqueued.id, output);

    const completed = await queue.get(enqueued.id);
    assert.equal(completed?.status, "completed");
    assert.deepEqual(completed?.output, output);
    assert.equal(completed?.error, undefined);
  });

  it("fails a job with an error message", async () => {
    const enqueued = await queue.enqueue("answer_question", { testId: randomUUID() });

    const errorMsg = "Model returned malformed JSON";
    await queue.fail(enqueued.id, errorMsg);

    const failed = await queue.get(enqueued.id);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.error, errorMsg);
  });

  it("throws when completing or failing a non-existent job", async () => {
    const bogusId = randomUUID();
    await assert.rejects(() => queue.complete(bogusId, {}), /AI job not found/);
    await assert.rejects(() => queue.fail(bogusId, "test error"), /AI job not found/);
  });
});
