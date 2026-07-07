import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { PostgresSourceMapStore } from "./postgres-source-map-store.js";
import { makeTestPool } from "../test-support/db-pool.js";

const databaseUrl = process.env.DATABASE_URL;

describe("PostgresSourceMapStore", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  const store = new PostgresSourceMapStore(makeTestPool(databaseUrl as string));

  it("round-trips an entry through upsert and listBySource", async () => {
    const sourceId = `src-${randomUUID()}`;
    const created = await store.upsert({
      sourceId,
      topic: "event system",
      paths: ["src/events/", "docs/events.md"],
      description: "Event bus and handlers live here",
      observedSha: "abc123"
    });
    assert.ok(created.id);
    const entries = await store.listBySource(sourceId, 10);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].paths, ["src/events/", "docs/events.md"]);
    assert.equal(entries[0].observedSha, "abc123");
  });

  it("upsert replaces on (source_id, topic) and bumps updated_at", async () => {
    const sourceId = `src-${randomUUID()}`;
    const first = await store.upsert({ sourceId, topic: "t", paths: ["a/"], description: "old" });
    const second = await store.upsert({ sourceId, topic: "t", paths: ["b/"], description: "new" });
    assert.equal(second.id, first.id);
    assert.deepEqual(second.paths, ["b/"]);
    assert.ok(second.updatedAt >= first.updatedAt);
    assert.equal((await store.listBySource(sourceId, 10)).length, 1);
  });

  it("an upsert without observedSha clears a previously recorded sha (latest observation wins)", async () => {
    const sourceId = `src-${randomUUID()}`;
    await store.upsert({ sourceId, topic: "t", paths: ["a/"], description: "d", observedSha: "abc123" });
    const updated = await store.upsert({ sourceId, topic: "t", paths: ["a/"], description: "d" });
    assert.equal(updated.observedSha, undefined);
  });

  it("pruneToLimit deletes the oldest-updated entries beyond the cap", async () => {
    const sourceId = `src-${randomUUID()}`;
    for (const topic of ["a", "b", "c"]) {
      await store.upsert({ sourceId, topic, paths: ["p/"], description: "d" });
    }
    const evicted = await store.pruneToLimit(sourceId, 2);
    assert.equal(evicted, 1);
    assert.equal((await store.listBySource(sourceId, 10)).length, 2);
  });
});
