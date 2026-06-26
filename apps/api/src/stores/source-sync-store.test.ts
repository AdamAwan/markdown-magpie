import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemorySourceSyncStore } from "./source-sync-store.js";

test("source-sync state records last processed sha per flow and source", async () => {
  const store = new InMemorySourceSyncStore();
  await store.setState(undefined, "src-1", "aaa");
  await store.setState("flow-a", "src-1", "bbb");

  assert.equal((await store.getState(undefined, "src-1"))?.lastSha, "aaa");
  assert.equal((await store.getState("flow-a", "src-1"))?.lastSha, "bbb");
});

test("source-sync state reset clears baselines", async () => {
  const store = new InMemorySourceSyncStore();
  await store.setState(undefined, "src-1", "aaa");
  await store.reset();
  assert.equal(await store.getState(undefined, "src-1"), undefined);
});
