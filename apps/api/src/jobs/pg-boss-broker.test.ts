import assert from "node:assert/strict";
import { test } from "node:test";
import { allQueueDefinitions } from "@magpie/jobs";
import { pgBossQueueOptions, queueDefinitionsForType } from "./pg-boss-broker.js";

test("pgBossQueueOptions applies explicit test overrides without changing untouched policy fields", () => {
  const options = pgBossQueueOptions({
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 600,
    heartbeatSeconds: 60,
    expireInSeconds: 300,
    retentionSeconds: 1_209_600,
    deleteAfterSeconds: 2_592_000,
    deadLetter: "refresh_flow_snapshot__dead_letter"
  }, {
    retryLimit: 1,
    retryDelay: 1,
    retryBackoff: false
  });

  assert.deepEqual(options, {
    retryLimit: 1,
    retryDelay: 1,
    retryBackoff: false,
    heartbeatSeconds: 60,
    expireInSeconds: 300,
    retentionSeconds: 1_209_600,
    deleteAfterSeconds: 2_592_000,
    deadLetter: "refresh_flow_snapshot__dead_letter"
  });
});

test("queueDefinitionsForType scopes a provider-routed type to its provider work queues and their dead letters, not every queue", () => {
  const scoped = queueDefinitionsForType("answer_question");
  const allQueues = allQueueDefinitions();

  // Strictly fewer than the full catalog: this is the list() scaling fix — a
  // type filter must not still scan every queue pg-boss knows about.
  assert.ok(scoped.length < allQueues.length);
  assert.ok(scoped.length > 0);

  for (const queue of scoped) {
    assert.equal(queue.type, "answer_question");
  }

  // One work queue + one dead-letter queue per AI provider.
  const workQueues = scoped.filter((queue) => !queue.deadLetter);
  const deadLetterQueues = scoped.filter((queue) => queue.deadLetter);
  assert.equal(workQueues.length, deadLetterQueues.length);
  assert.ok(workQueues.length >= 2, "expected multiple provider-routed work queues");
});

test("queueDefinitionsForType scopes a non-provider-routed type to exactly its work queue and dead letter", () => {
  const scoped = queueDefinitionsForType("refresh_flow_snapshot");

  assert.equal(scoped.length, 2);
  assert.ok(scoped.every((queue) => queue.type === "refresh_flow_snapshot"));
  assert.equal(scoped.filter((queue) => !queue.deadLetter).length, 1);
  assert.equal(scoped.filter((queue) => queue.deadLetter).length, 1);
});

test("queueDefinitionsForType partitions the full catalog: every queue belongs to exactly one type's scope", () => {
  const allQueues = allQueueDefinitions();
  const types = [...new Set(allQueues.map((queue) => queue.type))];
  const scopedTotal = types.reduce((sum, type) => sum + queueDefinitionsForType(type).length, 0);

  assert.equal(scopedTotal, allQueues.length);
});
