import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidCron, nextCronTime } from "@magpie/core";
import { InMemoryCrunchStore } from "./stores/crunch-store.js";

test("InMemoryCrunchStore completes a queued run by job id", async () => {
  const store = new InMemoryCrunchStore();
  const run = await store.createRun({ trigger: "manual", documentCount: 2, status: "running", jobId: "job-1" });

  const byJob = await store.getRunByJobId("job-1");
  assert.equal(byJob?.id, run.id);

  const completed = await store.completeRun(run.id, { summary: "done", operations: [], rationale: "ok" });
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.plan?.summary, "done");
});

test("InMemoryCrunchStore.getRunByJobId returns the newest run sharing a job id (matches Postgres)", async () => {
  const store = new InMemoryCrunchStore();
  const older = await store.createRun({ trigger: "manual", documentCount: 1, status: "running", jobId: "job-x" });
  // Force a strictly-later createdAt so the newest-wins ordering is deterministic.
  await new Promise((resolve) => setTimeout(resolve, 2));
  const newer = await store.createRun({ trigger: "manual", documentCount: 1, status: "running", jobId: "job-x" });

  assert.notEqual(older.id, newer.id);
  const byJob = await store.getRunByJobId("job-x");
  assert.equal(byJob?.id, newer.id);
});

test("InMemoryCrunchStore persists the enabled flag and cron; run timing is owned by pg-boss", async () => {
  const store = new InMemoryCrunchStore();

  const enabled = await store.updateSettings("cats", { enabled: true, cron: "0 2 * * *" });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.cron, "0 2 * * *");

  const disabled = await store.updateSettings("cats", { enabled: false, cron: "0 2 * * *" });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.cron, "0 2 * * *");
});

test("nextCronTime resolves the next matching minute in local time", () => {
  // 02:00 daily, from 01:30 the same day → 02:00 the same day.
  const from = new Date(2026, 0, 1, 1, 30, 0);
  const next = nextCronTime("0 2 * * *", from);
  assert.ok(next);
  assert.equal(next?.getHours(), 2);
  assert.equal(next?.getMinutes(), 0);
  assert.equal(next?.getDate(), 1);

  // After today's run has passed, it rolls to the next day.
  const after = nextCronTime("0 2 * * *", new Date(2026, 0, 1, 2, 0, 0));
  assert.equal(after?.getDate(), 2);
});

test("isValidCron accepts standard expressions and rejects malformed ones", () => {
  assert.equal(isValidCron("0 2 * * *"), true);
  assert.equal(isValidCron("*/15 9-17 * * 1-5"), true);
  assert.equal(isValidCron("0 2 * *"), false); // too few fields
  assert.equal(isValidCron("60 2 * * *"), false); // minute out of range
  assert.equal(isValidCron("nonsense"), false);
});
