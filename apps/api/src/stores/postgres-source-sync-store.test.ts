import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { PostgresSourceSyncStore } from "./postgres-source-sync-store.js";

// Integration tests for the Postgres-backed source sync store. They self-skip
// unless DATABASE_URL points at a migrated database (see scripts/migrate.mjs).
const databaseUrl = process.env.DATABASE_URL;

describe("PostgresSourceSyncStore", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  const store = new PostgresSourceSyncStore(databaseUrl as string);

  it("round-trips state through setState and getState", async () => {
    const flowId = `flow-${randomUUID()}`;
    const sourceId = `src-${randomUUID()}`;
    const lastSha = "def456";

    const created = await store.setState(flowId, sourceId, lastSha);
    assert.equal(created.flowId, flowId);
    assert.equal(created.sourceId, sourceId);
    assert.equal(created.lastSha, lastSha);
    assert.ok(created.lastCheckedAt, "lastCheckedAt should be stamped");

    const fetched = await store.getState(flowId, sourceId);
    assert.equal(fetched?.flowId, flowId);
    assert.equal(fetched?.sourceId, sourceId);
    assert.equal(fetched?.lastSha, lastSha);
  });

  it("upserts state when called again with the same flow and source", async () => {
    const flowId = `flow-${randomUUID()}`;
    const sourceId = `src-${randomUUID()}`;

    await store.setState(flowId, sourceId, "sha1");
    const second = await store.setState(flowId, sourceId, "sha2");

    assert.equal(second.lastSha, "sha2");
    assert.ok(second.lastCheckedAt);
    assert.equal((await store.getState(flowId, sourceId))?.lastSha, "sha2");
  });

  it("tracks state separately for the default flow (undefined flowId)", async () => {
    const sourceId = `src-${randomUUID()}`;

    await store.setState(`flow-a`, sourceId, "sha-a");
    await store.setState(undefined, sourceId, "sha-default");

    assert.equal((await store.getState(`flow-a`, sourceId))?.lastSha, "sha-a");
    assert.equal((await store.getState(undefined, sourceId))?.lastSha, "sha-default");
  });

  it("reset clears state baselines", async () => {
    const sourceId = `src-${randomUUID()}`;

    await store.setState(undefined, sourceId, "sha-default");
    assert.equal((await store.getState(undefined, sourceId))?.lastSha, "sha-default");

    await store.reset();
    assert.equal(await store.getState(undefined, sourceId), undefined);
  });
});
