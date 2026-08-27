import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryKnowledgeChangeStore, type KnowledgeChangeRecord } from "./knowledge-change-store.js";

function entry(overrides: Partial<KnowledgeChangeRecord> = {}): KnowledgeChangeRecord {
  return {
    repositoryId: "kb",
    documentId: "kb:guide.md",
    path: "guide.md",
    anchor: "rate-tiers",
    heading: "Rate tiers",
    kind: "section_changed",
    commitSha: "abc123",
    cause: "external",
    ...overrides
  };
}

describe("InMemoryKnowledgeChangeStore", () => {
  it("dedupes on (documentId, anchor, kind, commitSha)", async () => {
    const store = new InMemoryKnowledgeChangeStore();

    assert.equal(await store.record([entry()]), 1);
    assert.equal(await store.record([entry()]), 0);
    assert.equal((await store.listRecent(10)).length, 1);
  });

  it("records the same change again at a different commit", async () => {
    const store = new InMemoryKnowledgeChangeStore();

    await store.record([entry()]);
    assert.equal(await store.record([entry({ commitSha: "def456" })]), 1);
    assert.equal((await store.listRecent(10)).length, 2);
  });

  it("keeps entries that differ only in anchor or kind", async () => {
    const store = new InMemoryKnowledgeChangeStore();

    await store.record([entry()]);
    assert.equal(await store.record([entry({ anchor: "limits" })]), 1);
    assert.equal(await store.record([entry({ kind: "section_removed" })]), 1);
    assert.equal((await store.listRecent(10)).length, 3);
  });

  it("dedupes document-level entries, which carry no anchor", async () => {
    const store = new InMemoryKnowledgeChangeStore();
    const removal = entry({ kind: "document_removed", anchor: undefined, heading: undefined });

    assert.equal(await store.record([removal]), 1);
    assert.equal(await store.record([removal]), 0);
  });

  it("dedupes an entry with no commit sha within the short window", async () => {
    // A destination with no resolvable git context has no commit to key on; the
    // window keeps a replay from duplicating without swallowing a later real edit.
    const store = new InMemoryKnowledgeChangeStore();
    const unversioned = entry({ commitSha: undefined });

    assert.equal(await store.record([unversioned]), 1);
    assert.equal(await store.record([unversioned]), 0);
    assert.equal((await store.listRecent(10)).length, 1);
  });

  it("returns entries newest first", async () => {
    const store = new InMemoryKnowledgeChangeStore();

    await store.record([entry({ commitSha: "one" }), entry({ commitSha: "two" })]);

    assert.deepEqual(
      (await store.listRecent(10)).map((recorded) => recorded.commitSha),
      ["two", "one"]
    );
  });
});
