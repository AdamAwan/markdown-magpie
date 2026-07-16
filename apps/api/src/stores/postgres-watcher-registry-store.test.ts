import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { PostgresWatcherRegistryStore } from "./postgres-watcher-registry-store.js";
import { makeTestPool } from "../test-support/db-pool.js";

// Integration tests for the Postgres-backed watcher registry. They self-skip
// unless DATABASE_URL points at a migrated database (see scripts/migrate.mjs);
// CI provides one via a pgvector service container. Assertions filter by the
// unique watcher name each test creates, so other rows never make them flaky.
const databaseUrl = process.env.DATABASE_URL;

describe("PostgresWatcherRegistryStore", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  const store = new PostgresWatcherRegistryStore(makeTestPool(databaseUrl as string));

  it("records an idle watcher with its advertised capabilities", async () => {
    const name = `w-${randomUUID()}`;
    await store.touch({ name, status: "idle", capabilities: ["codex"] });

    const mine = (await store.list(60_000)).find((w) => w.name === name);
    assert.equal(mine?.status, "idle");
    assert.deepEqual(mine?.capabilities, ["codex"]);
    assert.equal(mine?.currentJobId, undefined);
  });

  it("marks a watcher busy with its current job and keeps capabilities when omitted", async () => {
    const name = `w-${randomUUID()}`;
    await store.touch({ name, status: "idle", capabilities: ["github"] });
    // A heartbeat carries no capabilities; the stored ones must survive the upsert.
    await store.touch({ name, status: "busy", currentJobId: "job-123" });

    const mine = (await store.list(60_000)).find((w) => w.name === name);
    assert.equal(mine?.status, "busy");
    assert.equal(mine?.currentJobId, "job-123");
    assert.deepEqual(mine?.capabilities, ["github"]);
  });

  it("clears the current job when the watcher goes idle again", async () => {
    const name = `w-${randomUUID()}`;
    await store.touch({ name, status: "busy", currentJobId: "job-x", capabilities: ["codex"] });
    await store.touch({ name, status: "idle" });

    const mine = (await store.list(60_000)).find((w) => w.name === name);
    assert.equal(mine?.status, "idle");
    assert.equal(mine?.currentJobId, undefined);
  });

  it("prunes watchers silent past the active window", async () => {
    const name = `w-${randomUUID()}`;
    await store.touch({ name, status: "idle", capabilities: ["codex"] });
    // A zero-length window: a row inserted in an earlier transaction is already
    // stale relative to this list()'s now(), so it is pruned and excluded.
    const listed = await store.list(0);
    assert.equal(
      listed.find((w) => w.name === name),
      undefined
    );
  });
});
