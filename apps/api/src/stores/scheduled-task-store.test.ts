import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryScheduledTaskStore } from "./scheduled-task-store.js";

test("updateSettings schedules a next run when enabled and clears it when disabled", async () => {
  const store = new InMemoryScheduledTaskStore();

  const enabled = await store.updateSettings("pull-request-refresh", { enabled: true, cron: "*/10 * * * *" });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.cron, "*/10 * * * *");
  assert.ok(enabled.nextRunAt, "enabled schedule should have a next run time");

  const disabled = await store.updateSettings("pull-request-refresh", { enabled: false, cron: "*/10 * * * *" });
  assert.equal(disabled.nextRunAt, undefined);
});

test("getSettings returns undefined for an unsaved task so the registry default applies", async () => {
  const store = new InMemoryScheduledTaskStore();
  assert.equal(await store.getSettings("pull-request-refresh"), undefined);
});

test("touchSchedule updates an existing row and no-ops for an unknown task", async () => {
  const store = new InMemoryScheduledTaskStore();
  await store.updateSettings("pull-request-refresh", { enabled: true, cron: "0 * * * *" });

  const touched = await store.touchSchedule("pull-request-refresh", new Date(0).toISOString(), new Date(1000).toISOString());
  assert.equal(touched?.lastRunAt, new Date(0).toISOString());
  assert.equal(touched?.nextRunAt, new Date(1000).toISOString());
  // The enabled flag and cron are preserved across a schedule touch.
  assert.equal(touched?.enabled, true);
  assert.equal(touched?.cron, "0 * * * *");

  assert.equal(await store.touchSchedule("unknown", new Date(0).toISOString(), new Date(1000).toISOString()), undefined);
});

test("touchSchedule with expectedNextRunAt claims a run exactly once when several tick at the same slot", async () => {
  const store = new InMemoryScheduledTaskStore();
  await store.updateSettings("gaps-to-pull-requests", { enabled: true, cron: "0 * * * *" });
  const due = (await store.getSettings("gaps-to-pull-requests"))?.nextRunAt;
  assert.ok(due, "an enabled task should have a due time to claim against");

  const next = new Date(Date.parse(due) + 3_600_000).toISOString();
  // First claimant matches the still-current next_run_at and wins.
  const winner = await store.touchSchedule("gaps-to-pull-requests", new Date().toISOString(), next, due);
  assert.ok(winner, "the first claimant should win the slot");
  assert.equal(winner?.nextRunAt, next);

  // A second instance ticking on the same original due time finds it already
  // advanced and loses the claim, so it must not run the task.
  const loser = await store.touchSchedule("gaps-to-pull-requests", new Date().toISOString(), next, due);
  assert.equal(loser, undefined, "a stale claim must return undefined so the caller skips");
});
