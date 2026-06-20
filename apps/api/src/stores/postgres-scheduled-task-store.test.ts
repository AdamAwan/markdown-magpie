import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { PostgresScheduledTaskStore } from "./postgres-scheduled-task-store.js";

// Integration tests for the Postgres-backed scheduled task store. They self-skip
// unless DATABASE_URL points at a migrated database (see scripts/migrate.mjs);
// CI provides one via a pgvector service container. This mirrors the template in
// postgres-proposal-store.test.ts — round-trip through real SQL and assert by the
// ids you created so parallel rows never make the suite flaky.
const databaseUrl = process.env.DATABASE_URL;

describe("PostgresScheduledTaskStore", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  const store = new PostgresScheduledTaskStore(databaseUrl as string);

  it("round-trips settings through updateSettings and getSettings", async () => {
    const key = `roundtrip-${randomUUID()}`;
    const cron = "*/15 * * * *";

    const created = await store.updateSettings(key, { enabled: true, cron });
    assert.equal(created.key, key);
    assert.equal(created.enabled, true);
    assert.equal(created.cron, cron);
    assert.ok(created.nextRunAt, "enabled task should have a next run time");

    const fetched = await store.getSettings(key);
    assert.equal(fetched?.key, key);
    assert.equal(fetched?.enabled, true);
    assert.equal(fetched?.cron, cron);
    assert.equal(fetched?.nextRunAt, created.nextRunAt);
  });

  it("clears nextRunAt when a task is disabled", async () => {
    const key = `disable-${randomUUID()}`;

    await store.updateSettings(key, { enabled: true, cron: "0 * * * *" });
    const disabled = await store.updateSettings(key, { enabled: false, cron: "0 * * * *" });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.nextRunAt, undefined);
  });

  it("re-enables a task with a new cron schedule", async () => {
    const key = `reenable-${randomUUID()}`;

    await store.updateSettings(key, { enabled: true, cron: "*/5 * * * *" });
    await store.updateSettings(key, { enabled: false, cron: "*/5 * * * *" });
    const reEnabled = await store.updateSettings(key, { enabled: true, cron: "0 0 * * *" });
    assert.equal(reEnabled.enabled, true);
    assert.equal(reEnabled.cron, "0 0 * * *");
    assert.ok(reEnabled.nextRunAt);
  });

  it("updates lastRunAt and nextRunAt via touchSchedule", async () => {
    const key = `touch-${randomUUID()}`;
    const lastRun = new Date(Date.now() - 60000).toISOString();
    const nextRun = new Date(Date.now() + 60000).toISOString();

    await store.updateSettings(key, { enabled: true, cron: "0 * * * *" });

    const touched = await store.touchSchedule(key, lastRun, nextRun);
    assert.equal(touched?.lastRunAt, lastRun);
    assert.equal(touched?.nextRunAt, nextRun);
    // enabled and cron are preserved across a touch.
    assert.equal(touched?.enabled, true);
    assert.equal(touched?.cron, "0 * * * *");
  });

  it("touchSchedule returns undefined for an unknown task", async () => {
    const unknown = `unknown-${randomUUID()}`;
    const touched = await store.touchSchedule(unknown, new Date(0).toISOString(), new Date(1000).toISOString());
    assert.equal(touched, undefined);
  });

  it("includes created tasks in listSettings", async () => {
    const key1 = `list-${randomUUID()}`;
    const key2 = `list-${randomUUID()}`;

    await store.updateSettings(key1, { enabled: true, cron: "*/10 * * * *" });
    await store.updateSettings(key2, { enabled: false, cron: "0 12 * * *" });

    const all = await store.listSettings();
    const keys = all.map((s) => s.key);
    assert.ok(keys.includes(key1), "first task should appear in list");
    assert.ok(keys.includes(key2), "second task should appear in list");
  });
});
