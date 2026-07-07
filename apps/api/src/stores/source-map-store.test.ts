import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemorySourceMapStore } from "./source-map-store.js";

describe("InMemorySourceMapStore", () => {
  it("round-trips an entry through upsert and listBySource", async () => {
    const store = new InMemorySourceMapStore();
    const created = await store.upsert({
      sourceId: "s1",
      topic: "event system",
      paths: ["src/events/"],
      description: "Event bus and handlers live here",
      observedSha: "abc123"
    });
    assert.ok(created.id);
    assert.equal(created.createdAt, created.updatedAt);

    const entries = await store.listBySource("s1", 10);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].topic, "event system");
    assert.deepEqual(entries[0].paths, ["src/events/"]);
    assert.equal(entries[0].observedSha, "abc123");
  });

  it("replaces the entry for the same (sourceId, topic), keeping id and createdAt", async () => {
    const store = new InMemorySourceMapStore();
    const first = await store.upsert({ sourceId: "s1", topic: "t", paths: ["a/"], description: "old" });
    const second = await store.upsert({ sourceId: "s1", topic: "t", paths: ["b/"], description: "new" });
    assert.equal(second.id, first.id);
    assert.equal(second.createdAt, first.createdAt);
    assert.deepEqual(second.paths, ["b/"]);
    assert.equal(second.description, "new");
    assert.equal((await store.listBySource("s1", 10)).length, 1);
  });

  it("lists only the requested source, most-recently-updated first, capped by limit", async () => {
    const store = new InMemorySourceMapStore();
    await store.upsert({ sourceId: "s1", topic: "older", paths: ["a/"], description: "d" });
    await store.upsert({ sourceId: "s2", topic: "other-source", paths: ["x/"], description: "d" });
    await store.upsert({ sourceId: "s1", topic: "newer", paths: ["b/"], description: "d" });
    await store.upsert({ sourceId: "s1", topic: "older", paths: ["a2/"], description: "touched again" });

    const entries = await store.listBySource("s1", 1);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].topic, "older");
    assert.ok((await store.listBySource("s1", 10)).every((e) => e.sourceId === "s1"));
  });

  it("pruneToLimit evicts the oldest-updated entries beyond the cap", async () => {
    const store = new InMemorySourceMapStore();
    for (const topic of ["a", "b", "c"]) {
      await store.upsert({ sourceId: "s1", topic, paths: ["p/"], description: "d" });
      // Distinct updatedAt per entry so "oldest" is unambiguous.
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const evicted = await store.pruneToLimit("s1", 2);
    assert.equal(evicted, 1);
    const remaining = await store.listBySource("s1", 10);
    assert.deepEqual(remaining.map((e) => e.topic).sort(), ["b", "c"]);
  });

  it("reset removes everything", async () => {
    const store = new InMemorySourceMapStore();
    await store.upsert({ sourceId: "s1", topic: "t", paths: ["p/"], description: "d" });
    await store.reset();
    assert.deepEqual(await store.listBySource("s1", 10), []);
  });
});
