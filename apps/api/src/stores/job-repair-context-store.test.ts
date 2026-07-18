import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it, test } from "node:test";
import { InMemoryJobRepairContextStore, type JobRepairContextStore } from "./job-repair-context-store.js";
import { PostgresJobRepairContextStore } from "./postgres-job-repair-context-store.js";
import { makeTestPool } from "../test-support/db-pool.js";

// Shared round-trip suite exercised against both the in-memory and (when
// DATABASE_URL/RUN_PG_INTEGRATION is set) the Postgres store (#288d).
function runContract(name: string, makeStore: () => JobRepairContextStore): void {
  describe(name, () => {
    it("round-trips get / put / delete", async () => {
      const store = makeStore();
      const jobId = `job-${randomUUID()}`;
      assert.equal(await store.get(jobId), undefined);

      await store.put({
        jobId,
        targetType: "answer_question",
        priorOutput: { answer: "hi", citations: [{ sectionId: "s1" }] },
        issues: [{ path: "confidence", message: "Required" }],
        attempt: 1
      });

      const row = await store.get(jobId);
      assert.ok(row);
      assert.equal(row!.jobId, jobId);
      assert.equal(row!.targetType, "answer_question");
      assert.deepEqual(row!.priorOutput, { answer: "hi", citations: [{ sectionId: "s1" }] });
      assert.deepEqual(row!.issues, [{ path: "confidence", message: "Required" }]);
      assert.equal(row!.attempt, 1);
      assert.ok(row!.createdAt);

      await store.delete(jobId);
      assert.equal(await store.get(jobId), undefined);
    });

    it("put upserts on job_id (a replay never duplicates)", async () => {
      const store = makeStore();
      const jobId = `job-${randomUUID()}`;
      await store.put({ jobId, targetType: "summarize_gap", priorOutput: { a: 1 }, issues: [], attempt: 1 });
      await store.put({ jobId, targetType: "summarize_gap", priorOutput: { a: 2 }, issues: [], attempt: 1 });
      const row = await store.get(jobId);
      assert.deepEqual(row!.priorOutput, { a: 2 });
      await store.delete(jobId);
    });
  });
}

runContract("InMemoryJobRepairContextStore", () => new InMemoryJobRepairContextStore());

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  runContract("PostgresJobRepairContextStore", () => new PostgresJobRepairContextStore(makeTestPool(databaseUrl)));
} else {
  test("PostgresJobRepairContextStore round-trip (skipped: DATABASE_URL not set)", { skip: true }, () => {});
}
