import assert from "node:assert/strict";
import { test } from "node:test";
import { scheduledTaskDefinitions, findScheduledTask } from "./task-registry.js";

test("the registry has a single gaps-to-pull-requests reconciler at 10-minute cadence", () => {
  assert.equal(findScheduledTask("pull-request-refresh"), undefined, "separate refresh task is removed");
  const reconciler = findScheduledTask("gaps-to-pull-requests");
  assert.ok(reconciler);
  assert.equal(reconciler!.defaultCron, "*/10 * * * *");
});

test("source-change-sync remains registered alongside the reconciler", () => {
  assert.ok(findScheduledTask("source-change-sync"));
  assert.equal(scheduledTaskDefinitions.length, 2);
});
