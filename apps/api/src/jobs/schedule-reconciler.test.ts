import assert from "node:assert/strict";
import { test } from "node:test";
import { makeTestContext } from "../test-support/context.js";
import { reconcileSchedules } from "./schedule-reconciler.js";

// Helper: the (type, key, enabled, cron) tuples currently queued in the broker,
// in a stable order so assertions don't depend on reconcile ordering.
async function scheduledKeys(ctx: ReturnType<typeof makeTestContext>) {
  const schedules = await ctx.jobs.listSchedules();
  return schedules
    .map(({ type, key, cron }) => ({ type, key, cron }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

test("reconcile builds per-task schedules for the default flow", async () => {
  const ctx = makeTestContext();
  await ctx.stores.scheduledTasks.updateSettings("gaps-to-pull-requests::default", { enabled: true, cron: "*/10 * * * *" });
  await ctx.stores.scheduledTasks.updateSettings("source-change-sync::default", { enabled: true, cron: "*/10 * * * *" });
  await ctx.stores.scheduledTasks.updateSettings("snapshot-refresh::default", { enabled: true, cron: "*/5 * * * *" });

  await reconcileSchedules(ctx);

  assert.deepEqual(await scheduledKeys(ctx), [
    { type: "process_gaps_to_pull_requests", key: "task:gaps-to-pull-requests::default", cron: "*/10 * * * *" },
    { type: "refresh_pull_requests", key: "task:snapshot-refresh::default", cron: "*/5 * * * *" },
    { type: "source_change_sync", key: "task:source-change-sync::default", cron: "*/10 * * * *" }
  ].sort((left, right) => left.key.localeCompare(right.key)));
});

test("reconcile is idempotent: running twice produces the same schedule set", async () => {
  const ctx = makeTestContext();
  await ctx.stores.scheduledTasks.updateSettings("snapshot-refresh::default", { enabled: true, cron: "*/5 * * * *" });

  await reconcileSchedules(ctx);
  const first = await scheduledKeys(ctx);
  await reconcileSchedules(ctx);
  const second = await scheduledKeys(ctx);

  assert.deepEqual(second, first);
});

test("disabling a setting unschedules its key on the next reconcile", async () => {
  const ctx = makeTestContext();
  await ctx.stores.scheduledTasks.updateSettings("snapshot-refresh::default", { enabled: true, cron: "*/5 * * * *" });
  await reconcileSchedules(ctx);

  // The FakeJobBroker reflects enabled=false in its ScheduleView, so a disabled
  // schedule is observable as not enabled rather than gone — assert on that.
  await ctx.stores.scheduledTasks.updateSettings("snapshot-refresh::default", { enabled: false, cron: "*/5 * * * *" });
  await reconcileSchedules(ctx);

  const snapshot = (await ctx.jobs.listSchedules()).find((s) => s.key === "task:snapshot-refresh::default");
  assert.equal(snapshot?.enabled, false, "disabled task schedule must be reconciled to enabled=false");
});

test("reconcile expands schedules per configured flow", async () => {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [
    { id: "alpha", name: "Alpha", sourceIds: [], destinationId: "kb" },
    { id: "beta", name: "Beta", sourceIds: [], destinationId: "kb" }
  ];
  await ctx.stores.scheduledTasks.updateSettings("source-change-sync::alpha", { enabled: true, cron: "0 2 * * *" });
  await ctx.stores.scheduledTasks.updateSettings("source-change-sync::beta", { enabled: true, cron: "*/10 * * * *" });

  await reconcileSchedules(ctx);

  assert.deepEqual(await scheduledKeys(ctx), [
    { type: "source_change_sync", key: "task:source-change-sync::alpha", cron: "0 2 * * *" },
    { type: "source_change_sync", key: "task:source-change-sync::beta", cron: "*/10 * * * *" }
  ].sort((left, right) => left.key.localeCompare(right.key)));
});
