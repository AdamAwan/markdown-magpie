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
    assert.equal(created.consensusCount, 1);
    const entries = await store.listBySource(sourceId, 10);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].paths, ["src/events/", "docs/events.md"]);
    assert.equal(entries[0].observedSha, "abc123");
    assert.equal(entries[0].consensusCount, 1);
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

  it("increments consensus count when paths overlap above threshold (Jaccard > 0.5)", async () => {
    const sourceId = `src-${randomUUID()}`;
    const first = await store.upsert({
      sourceId,
      topic: "events",
      paths: ["src/events/", "lib/emitter.ts", "src/handlers/"],
      description: "Event system"
    });
    assert.equal(first.consensusCount, 1);

    // Agent 2 agrees: 2 of 3 union paths overlap (2/3 = 66% > 50%)
    const second = await store.upsert({
      sourceId,
      topic: "events",
      paths: ["src/events/", "src/handlers/"],
      description: "Event system"
    });
    assert.equal(second.consensusCount, 2);
    assert.equal(second.id, first.id);

    // Agent 3 agrees again: 2 of 3 union paths overlap with agent 2 (2/3 = 66% > 50%)
    const third = await store.upsert({
      sourceId,
      topic: "events",
      paths: ["src/events/", "src/handlers/", "lib/index.ts"],
      description: "Event system"
    });
    assert.equal(third.consensusCount, 3);
  });

  it("resets consensus count when paths contradict (Jaccard <= 0.5)", async () => {
    const sourceId = `src-${randomUUID()}`;
    const first = await store.upsert({
      sourceId,
      topic: "api",
      paths: ["src/api/", "src/rest/", "src/routes/"],
      description: "REST API"
    });
    assert.equal(first.consensusCount, 1);

    // Agent 2 disagrees: only 1 of 5 union paths overlap (1/5 = 20% <= 50%)
    const second = await store.upsert({
      sourceId,
      topic: "api",
      paths: ["src/api/", "lib/graphql/", "server/"],
      description: "Mixed API"
    });
    assert.equal(second.consensusCount, 1);

    // Agreement returns from agent 3: 2 of 3 union paths overlap with agent 2 (2/3 = 66% > 50%)
    const third = await store.upsert({
      sourceId,
      topic: "api",
      paths: ["src/api/", "lib/graphql/"],
      description: "Mixed API"
    });
    assert.equal(third.consensusCount, 2);
  });

  it("caps consensus count at 5", async () => {
    const sourceId = `src-${randomUUID()}`;
    let entry = await store.upsert({
      sourceId,
      topic: "t",
      paths: ["p/"],
      description: "d"
    });
    assert.equal(entry.consensusCount, 1);

    for (let i = 0; i < 10; i++) {
      entry = await store.upsert({
        sourceId,
        topic: "t",
        paths: ["p/"],
        description: "d"
      });
    }
    assert.equal(entry.consensusCount, 5);
  });
});
