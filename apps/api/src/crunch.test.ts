import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMockCrunchPlan, isValidCron, nextCronTime } from "@magpie/core";
import { InMemoryCrunchStore, nextRunFor } from "./stores/crunch-store.js";

function largeMultiTopicDoc(): string {
  const section = (heading: string) =>
    `## ${heading}\n\n${"This section has enough prose to make the document large. ".repeat(12)}\n`;
  return `# Big Document\n\n${section("Setup")}${section("Usage")}${section("Troubleshooting")}`;
}

test("buildMockCrunchPlan splits a large multi-topic document into focused files", () => {
  const plan = buildMockCrunchPlan([{ path: "docs/big.md", content: largeMultiTopicDoc() }]);
  const split = plan.operations.find((operation) => operation.kind === "split");

  assert.ok(split, "expected a split operation");
  assert.deepEqual(split?.deletes, ["docs/big.md"]);
  assert.equal(split?.writes.length, 3);
  assert.ok(split?.writes.every((write) => write.path.startsWith("docs/big/")));
});

test("buildMockCrunchPlan consolidates several small documents in one folder", () => {
  const plan = buildMockCrunchPlan([
    { path: "cats/care.md", content: "# Care\n\nKeep water available." },
    { path: "cats/health.md", content: "# Health\n\nWatch for warning signs." }
  ]);
  const consolidate = plan.operations.find((operation) => operation.kind === "consolidate");

  assert.ok(consolidate, "expected a consolidate operation");
  assert.equal(consolidate?.writes.length, 1);
  assert.equal(consolidate?.writes[0].path, "cats/overview.md");
  assert.deepEqual(consolidate?.deletes.sort(), ["cats/care.md", "cats/health.md"]);
});

test("buildMockCrunchPlan leaves a tidy knowledge base unchanged", () => {
  const plan = buildMockCrunchPlan([{ path: "solo.md", content: "# Solo\n\nA single focused document." }]);
  assert.equal(plan.operations.length, 0);
});

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

test("InMemoryCrunchStore schedules a next run when enabled and clears it when disabled", async () => {
  const store = new InMemoryCrunchStore();

  const enabled = await store.updateSettings("cats", { enabled: true, cron: "0 2 * * *" });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.cron, "0 2 * * *");
  assert.ok(enabled.nextRunAt, "enabled schedule should have a next run time");

  const disabled = await store.updateSettings("cats", { enabled: false, cron: "0 2 * * *" });
  assert.equal(disabled.nextRunAt, undefined);
});

test("touchSchedule preserves the enabled flag", async () => {
  const store = new InMemoryCrunchStore();
  await store.updateSettings(undefined, { enabled: true, cron: "*/30 * * * *" });

  const next = nextRunFor(true, "*/30 * * * *", new Date(0)) ?? "";
  const touched = await store.touchSchedule(undefined, new Date(0).toISOString(), next);
  assert.equal(touched.enabled, true);
  assert.equal(touched.lastRunAt, new Date(0).toISOString());
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
