import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it, test } from "node:test";
import { InMemoryOrchestrationFollowupStore, type OrchestrationFollowupStore } from "./orchestration-followup-store.js";
import { PostgresOrchestrationFollowupStore } from "./postgres-orchestration-followup-store.js";
import { makeTestPool } from "../test-support/db-pool.js";

// Shared contract exercised against the in-memory store and, when DATABASE_URL is
// set (npm run test:db), the Postgres store.
function runContract(name: string, makeStore: () => OrchestrationFollowupStore): void {
  describe(name, () => {
    it("registers a pending row and reads it back", async () => {
      const store = makeStore();
      const jobId = `job-${randomUUID()}`;
      assert.equal(await store.get(jobId), undefined);

      const row = await store.register({
        jobId,
        orchestrator: "verify_gap_closure",
        scopeKey: "proposal-1",
        context: { questionId: "q1" }
      });
      assert.equal(row.status, "pending");
      assert.deepEqual(row.context, { questionId: "q1" });
      assert.ok(row.createdAt);
      assert.deepEqual(await store.get(jobId), row);
    });

    it("register is insert-if-absent: a reused job keeps its original owner", async () => {
      const store = makeStore();
      const jobId = `job-${randomUUID()}`;
      await store.register({ jobId, orchestrator: "correctness_patrol", scopeKey: "run-a", context: { n: 1 } });
      const second = await store.register({
        jobId,
        orchestrator: "correctness_patrol",
        scopeKey: "run-b",
        context: { n: 2 }
      });
      assert.equal(second.scopeKey, "run-a");
      assert.deepEqual(second.context, { n: 1 });
    });

    it("settles exactly once and keeps the result", async () => {
      const store = makeStore();
      const jobId = `job-${randomUUID()}`;
      await store.register({ jobId, orchestrator: "correctness_patrol", scopeKey: "run", context: {} });

      assert.equal(await store.settle(jobId, { checked: true }), true);
      assert.equal(await store.settle(jobId, { checked: false }), false, "a replayed settle reports no transition");
      const row = await store.get(jobId);
      assert.equal(row?.status, "settled");
      assert.deepEqual(row?.result, { checked: true });
      assert.ok(row?.settledAt);
      assert.equal(await store.settle(`missing-${randomUUID()}`, {}), false);
    });

    it("lists a scope oldest-first and never leaks another scope or orchestrator", async () => {
      const store = makeStore();
      const scope = `scope-${randomUUID()}`;
      const first = `job-${randomUUID()}`;
      const second = `job-${randomUUID()}`;
      await store.register({ jobId: first, orchestrator: "verify_gap_closure", scopeKey: scope, context: {} });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await store.register({ jobId: second, orchestrator: "verify_gap_closure", scopeKey: scope, context: {} });
      await store.register({
        jobId: `job-${randomUUID()}`,
        orchestrator: "verify_gap_closure",
        scopeKey: `${scope}-other`,
        context: {}
      });
      await store.register({
        jobId: `job-${randomUUID()}`,
        orchestrator: "correctness_patrol",
        scopeKey: scope,
        context: {}
      });

      const listed = await store.listByScope("verify_gap_closure", scope);
      assert.deepEqual(
        listed.map((row) => row.jobId),
        [first, second]
      );
    });

    it("setContext replaces the context", async () => {
      const store = makeStore();
      const jobId = `job-${randomUUID()}`;
      await store.register({
        jobId,
        orchestrator: "correctness_patrol",
        scopeKey: "run",
        context: { stampHash: true }
      });
      await store.setContext(jobId, { stampHash: false });
      assert.deepEqual((await store.get(jobId))?.context, { stampHash: false });
    });

    it("deleteScope removes only that scope's rows", async () => {
      const store = makeStore();
      const scope = `scope-${randomUUID()}`;
      const kept = `job-${randomUUID()}`;
      const dropped = `job-${randomUUID()}`;
      await store.register({ jobId: dropped, orchestrator: "verify_gap_closure", scopeKey: scope, context: {} });
      await store.register({
        jobId: kept,
        orchestrator: "verify_gap_closure",
        scopeKey: `${scope}-other`,
        context: {}
      });
      await store.deleteScope("verify_gap_closure", scope);
      assert.equal(await store.get(dropped), undefined);
      assert.ok(await store.get(kept));
    });

    it("prunes old settled rows of finished scopes only, and only for the named orchestrator", async () => {
      const store = makeStore();
      const finishedScope = `run-${randomUUID()}`;
      const unfinishedScope = `run-${randomUUID()}`;
      const finished = `job-${randomUUID()}`;
      const answeredSibling = `job-${randomUUID()}`;
      const pending = `job-${randomUUID()}`;
      const otherOrchestrator = `job-${randomUUID()}`;
      await store.register({
        jobId: finished,
        orchestrator: "correctness_patrol",
        scopeKey: finishedScope,
        context: {}
      });
      await store.register({
        jobId: answeredSibling,
        orchestrator: "correctness_patrol",
        scopeKey: unfinishedScope,
        context: {}
      });
      await store.register({
        jobId: pending,
        orchestrator: "correctness_patrol",
        scopeKey: unfinishedScope,
        context: {}
      });
      await store.register({
        jobId: otherOrchestrator,
        orchestrator: "verify_gap_closure",
        scopeKey: finishedScope,
        context: {}
      });
      await store.settle(finished, {});
      await store.settle(answeredSibling, {});
      await store.settle(otherOrchestrator, {});

      await store.pruneSettledBefore("correctness_patrol", new Date(Date.now() - 60_000).toISOString());
      assert.ok(await store.get(finished), "a recently settled row survives");

      await store.pruneSettledBefore("correctness_patrol", new Date(Date.now() + 60_000).toISOString());
      assert.equal(await store.get(finished), undefined, "an old settled row of a finished scope is pruned");
      assert.ok(await store.get(pending), "a pending row is an outcome still owed and is never pruned");
      assert.ok(
        await store.get(answeredSibling),
        "a settled row is kept while its scope still waits on a sibling — it is work already paid for"
      );
      assert.ok(await store.get(otherOrchestrator), "another orchestrator's rows are untouched");
    });
  });
}

runContract("InMemoryOrchestrationFollowupStore", () => new InMemoryOrchestrationFollowupStore());

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  runContract(
    "PostgresOrchestrationFollowupStore",
    () => new PostgresOrchestrationFollowupStore(makeTestPool(databaseUrl))
  );
} else {
  test("PostgresOrchestrationFollowupStore contract (skipped: DATABASE_URL not set)", { skip: true }, () => {});
}
