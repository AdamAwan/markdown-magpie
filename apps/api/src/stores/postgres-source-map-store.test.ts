import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { PostgresSourceMapStore } from "./postgres-source-map-store.js";
import { makeTestPool } from "../test-support/db-pool.js";

const databaseUrl = process.env.DATABASE_URL;

describe("PostgresSourceMapStore", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  const pool = makeTestPool(databaseUrl as string);
  const store = new PostgresSourceMapStore(pool);

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

  it("treats an empty-string observedSha as absent, matching the in-memory store", async () => {
    const sourceId = `src-${randomUUID()}`;
    const created = await store.upsert({ sourceId, topic: "t", paths: ["a/"], description: "d", observedSha: "" });
    assert.equal(created.observedSha, undefined);
    const [entry] = await store.listBySource(sourceId, 10);
    assert.equal(entry.observedSha, undefined);
  });

  it("breaks equal-updated_at ties by most-recent write, not topic", async () => {
    const sourceId = `src-${randomUUID()}`;
    // Write order: c, b, a — then re-touch "c" so it is the most recent write
    // despite sorting last alphabetically.
    for (const topic of ["c", "b", "a"]) {
      await store.upsert({ sourceId, topic, paths: ["p/"], description: "d" });
    }
    await store.upsert({ sourceId, topic: "c", paths: ["p2/"], description: "re-touched" });
    // Force an exact updated_at tie across all rows: statement timestamps would
    // otherwise differ at microsecond resolution and mask the tie-break.
    await pool.query("UPDATE source_map_entries SET updated_at = now() WHERE source_id = $1", [sourceId]);

    const entries = await store.listBySource(sourceId, 10);
    assert.deepEqual(
      entries.map((e) => e.topic),
      ["c", "a", "b"],
      "ties resolve by write order (c re-touched last, then a, then b)"
    );
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
