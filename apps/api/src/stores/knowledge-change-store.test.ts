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
    assert.equal((await store.list({ limit: 10, offset: 0 })).length, 1);
  });

  it("records the same change again at a different commit", async () => {
    const store = new InMemoryKnowledgeChangeStore();

    await store.record([entry()]);
    assert.equal(await store.record([entry({ commitSha: "def456" })]), 1);
    assert.equal((await store.list({ limit: 10, offset: 0 })).length, 2);
  });

  it("keeps entries that differ only in anchor or kind", async () => {
    const store = new InMemoryKnowledgeChangeStore();

    await store.record([entry()]);
    assert.equal(await store.record([entry({ anchor: "limits" })]), 1);
    assert.equal(await store.record([entry({ kind: "section_removed" })]), 1);
    assert.equal((await store.list({ limit: 10, offset: 0 })).length, 3);
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
    assert.equal((await store.list({ limit: 10, offset: 0 })).length, 1);
  });

  it("returns entries newest first", async () => {
    const store = new InMemoryKnowledgeChangeStore();

    await store.record([entry({ commitSha: "one" }), entry({ commitSha: "two" })]);

    assert.deepEqual(
      (await store.list({ limit: 10, offset: 0 })).map((recorded) => recorded.commitSha),
      ["two", "one"]
    );
  });
});

// The query surface the read endpoint is built on (rollout step 3). The in-memory
// store is what the unit tests run against; the Postgres backend mirrors these
// semantics and is asserted against a real database in
// postgres-knowledge-change-store.integration.test.ts.
describe("InMemoryKnowledgeChangeStore queries", () => {
  // Entries are stamped with the store's own clock, so a test that needs distinct
  // instants has to let it tick. Millisecond granularity — 2ms is enough.
  async function tick(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  async function populated(): Promise<InMemoryKnowledgeChangeStore> {
    const store = new InMemoryKnowledgeChangeStore();
    await store.record([
      entry({ commitSha: "c1", flowId: "billing", documentId: "kb:rates.md", anchor: "tiers", cause: "gap" }),
      entry({
        commitSha: "c2",
        flowId: "billing",
        documentId: "kb:rates.md",
        anchor: "limits",
        kind: "section_added",
        cause: "source_sync",
        sourceId: "product-repo"
      }),
      entry({ commitSha: "c3", flowId: "support", documentId: "kb:faq.md", anchor: "refunds", cause: "patrol" })
    ]);
    return store;
  }

  it("narrows by flow, document, source, cause and kind", async () => {
    const store = await populated();
    const commits = async (filters: Parameters<InMemoryKnowledgeChangeStore["list"]>[0]) =>
      (await store.list(filters)).map((change) => change.commitSha).sort();

    assert.deepEqual(await commits({ flowIds: ["billing"], limit: 10, offset: 0 }), ["c1", "c2"]);
    assert.deepEqual(await commits({ documentId: "kb:faq.md", limit: 10, offset: 0 }), ["c3"]);
    assert.deepEqual(await commits({ sourceId: "product-repo", limit: 10, offset: 0 }), ["c2"]);
    assert.deepEqual(await commits({ cause: "patrol", limit: 10, offset: 0 }), ["c3"]);
    assert.deepEqual(await commits({ kind: "section_added", limit: 10, offset: 0 }), ["c2"]);
  });

  it("composes filters as an AND", async () => {
    const store = await populated();

    assert.deepEqual(
      (await store.list({ flowIds: ["billing"], kind: "section_added", limit: 10, offset: 0 })).map(
        (change) => change.commitSha
      ),
      ["c2"]
    );
    // Each filter alone matches something; together they match nothing.
    assert.deepEqual(await store.list({ flowIds: ["support"], cause: "gap", limit: 10, offset: 0 }), []);
  });

  it("filters on a half-open [since, until) window", async () => {
    const store = new InMemoryKnowledgeChangeStore();
    await store.record([entry({ commitSha: "old" })]);
    await tick();
    await store.record([entry({ commitSha: "new" })]);
    const boundary = (await store.list({ limit: 1, offset: 0 }))[0]!.changedAt;

    // `since` is inclusive: the entry stamped exactly at the boundary is in.
    assert.deepEqual(
      (await store.list({ since: boundary, limit: 10, offset: 0 })).map((change) => change.commitSha),
      ["new"]
    );
    // `until` is exclusive: the same entry is out, so a boundary belongs to
    // exactly one window.
    assert.deepEqual(
      (await store.list({ until: boundary, limit: 10, offset: 0 })).map((change) => change.commitSha),
      ["old"]
    );
  });

  it("pages newest first", async () => {
    const store = await populated();

    assert.deepEqual(
      (await store.list({ limit: 2, offset: 0 })).map((change) => change.commitSha),
      ["c3", "c2"]
    );
    assert.deepEqual(
      (await store.list({ limit: 2, offset: 2 })).map((change) => change.commitSha),
      ["c1"]
    );
  });

  it("summarizes the filtered window, not the whole log", async () => {
    const store = await populated();

    const all = await store.summarize({});
    assert.equal(all.total, 3);
    assert.equal(all.documentsTouched, 2);
    assert.equal(all.byKind.section_changed, 2);
    assert.equal(all.byKind.section_added, 1);
    assert.equal(all.byCause.gap, 1);
    assert.equal(all.byCause.source_sync, 1);
    assert.equal(all.byCause.patrol, 1);

    const billing = await store.summarize({ flowIds: ["billing"] });
    assert.equal(billing.total, 2);
    assert.equal(billing.documentsTouched, 1, "both billing entries touch the same document");
    assert.equal(billing.byCause.patrol, 0, "the support flow's entry is outside the window");
    // Every kind and cause is keyed, zeros included, so a caller can render a
    // stable breakdown without knowing which values occurred.
    assert.equal(billing.byKind.document_removed, 0);
  });

  it("returns the newest entry per (documentId, anchor) for a batch of sections", async () => {
    // The answer-path read (KC-6): one call for the whole retrieved set, newest
    // entry per section, and nothing at all for a section the log has never seen.
    const store = new InMemoryKnowledgeChangeStore();
    await store.record([entry({ commitSha: "c1", kind: "section_added", summary: "first draft" })]);
    await store.record([entry({ commitSha: "c2", kind: "section_changed", summary: "rate tier update" })]);
    await store.record([entry({ commitSha: "c3", anchor: "limits", heading: "Limits" })]);
    // A document-level entry carries no anchor and must never be picked up as a
    // section's change context.
    await store.record([entry({ commitSha: "c4", kind: "document_added", anchor: undefined, heading: undefined })]);

    const latest = await store.latestForSections([
      { documentId: "kb:guide.md", anchor: "rate-tiers" },
      { documentId: "kb:guide.md", anchor: "limits" },
      { documentId: "kb:guide.md", anchor: "never-changed" }
    ]);

    assert.deepEqual(
      latest.map((change) => [change.anchor, change.commitSha]).sort(),
      [
        ["limits", "c3"],
        ["rate-tiers", "c2"]
      ],
      "newest per anchor, and nothing for an anchor with no history"
    );
    assert.equal(latest.find((change) => change.anchor === "rate-tiers")?.summary, "rate tier update");
  });

  it("returns nothing for an empty batch of sections", async () => {
    const store = new InMemoryKnowledgeChangeStore();
    await store.record([entry()]);

    assert.deepEqual(await store.latestForSections([]), []);
  });

  it("reports the log's start instant for a scope, even when the window is empty", async () => {
    const store = await populated();
    const oldest = (await store.list({ limit: 10, offset: 0 })).at(-1)!.changedAt;

    assert.equal(await store.firstChangedAt({}), oldest);
    assert.equal(
      await store.firstChangedAt({ flowIds: ["support"] }),
      (await store.list({ flowIds: ["support"], limit: 1, offset: 0 }))[0]!.changedAt
    );
    // The point of the read: a filter that matches nothing still knows the log
    // exists, so an empty result reads as "nothing recorded" rather than
    // "nothing changed".
    assert.equal(await store.firstChangedAt({ flowIds: ["unknown"] }), undefined);
  });
});
