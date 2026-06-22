import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryScheduledTaskStore } from "./scheduled-task-store.js";

test("updateSettings persists the enabled flag and cron", async () => {
  const store = new InMemoryScheduledTaskStore();

  const enabled = await store.updateSettings("pull-request-refresh", { enabled: true, cron: "*/10 * * * *" });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.cron, "*/10 * * * *");

  const disabled = await store.updateSettings("pull-request-refresh", { enabled: false, cron: "*/10 * * * *" });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.cron, "*/10 * * * *");
});

test("getSettings returns undefined for an unsaved task so the registry default applies", async () => {
  const store = new InMemoryScheduledTaskStore();
  assert.equal(await store.getSettings("pull-request-refresh"), undefined);
});

test("listSettings returns every saved task", async () => {
  const store = new InMemoryScheduledTaskStore();
  await store.updateSettings("a", { enabled: true, cron: "0 * * * *" });
  await store.updateSettings("b", { enabled: false, cron: "*/5 * * * *" });

  const all = await store.listSettings();
  assert.deepEqual(all.map((setting) => setting.key).sort(), ["a", "b"]);
});
