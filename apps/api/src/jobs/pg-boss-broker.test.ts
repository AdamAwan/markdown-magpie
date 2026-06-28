import assert from "node:assert/strict";
import { test } from "node:test";
import { pgBossQueueOptions } from "./pg-boss-broker.js";

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
    deadLetter: "refresh_pull_requests__dead_letter"
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
    deadLetter: "refresh_pull_requests__dead_letter"
  });
});
