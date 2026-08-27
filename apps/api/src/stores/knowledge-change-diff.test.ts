import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffKnowledgeSnapshots, type DiffSection, type KnowledgeSnapshot } from "./knowledge-change-diff.js";

const DOCUMENT = { id: "kb:guide.md", path: "guide.md" };

function section(anchor: string, content: string, ordinal: number): DiffSection {
  return { documentId: DOCUMENT.id, anchor, heading: anchor.replace(/-/g, " "), content, ordinal };
}

function snapshot(sections: DiffSection[]): KnowledgeSnapshot {
  return { documents: [DOCUMENT], sections };
}

describe("diffKnowledgeSnapshots", () => {
  it("reports exactly one section_changed when one body is edited", () => {
    const before = snapshot([section("intro", "hello", 0), section("rates", "old rates", 1)]);
    const after = snapshot([section("intro", "hello", 0), section("rates", "new rates", 1)]);

    assert.deepEqual(diffKnowledgeSnapshots(before, after), [
      { documentId: DOCUMENT.id, path: "guide.md", anchor: "rates", heading: "rates", kind: "section_changed" }
    ]);
  });

  it("reports one section_added and no shear when a section is inserted near the top", () => {
    // This is the test the whole (documentId, anchor) identity choice exists for.
    // Under the ordinal-keyed comparison content_changed_at uses, inserting
    // "notice" at ordinal 1 shifts every section below it down one ordinal and
    // reports all of them as changed.
    const before = snapshot([
      section("intro", "hello", 0),
      section("rates", "rate body", 1),
      section("limits", "limit body", 2),
      section("support", "support body", 3)
    ]);
    const after = snapshot([
      section("intro", "hello", 0),
      section("notice", "brand new", 1),
      section("rates", "rate body", 2),
      section("limits", "limit body", 3),
      section("support", "support body", 4)
    ]);

    assert.deepEqual(diffKnowledgeSnapshots(before, after), [
      { documentId: DOCUMENT.id, path: "guide.md", anchor: "notice", heading: "notice", kind: "section_added" }
    ]);
  });

  it("reads a renamed heading as a removal plus an addition", () => {
    const before = snapshot([section("rate-tiers", "same body", 0)]);
    const after = snapshot([section("pricing-tiers", "same body", 0)]);

    assert.deepEqual(
      diffKnowledgeSnapshots(before, after).map((draft) => `${draft.kind}:${draft.anchor}`),
      // Entries within a document are emitted in anchor order.
      ["section_added:pricing-tiers", "section_removed:rate-tiers"]
    );
  });

  it("writes nothing when nothing changed", () => {
    const sections = [section("intro", "hello", 0), section("rates", "rate body", 1)];
    assert.deepEqual(diffKnowledgeSnapshots(snapshot(sections), snapshot(sections)), []);
  });

  it("reports a whole added or removed document as one document-level entry", () => {
    const before: KnowledgeSnapshot = { documents: [], sections: [] };
    const after = snapshot([section("intro", "hello", 0), section("rates", "rate body", 1)]);

    assert.deepEqual(diffKnowledgeSnapshots(before, after), [
      { documentId: DOCUMENT.id, path: "guide.md", kind: "document_added" }
    ]);
    assert.deepEqual(diffKnowledgeSnapshots(after, before), [
      { documentId: DOCUMENT.id, path: "guide.md", kind: "document_removed" }
    ]);
  });

  it("folds sections sharing an anchor onto a single identity", () => {
    // splitIntoSections suffixes repeated headings so this cannot arise from the
    // parser, but the diff takes plain section lists: two entries sharing an
    // anchor are one identity, so editing either is one section_changed rather
    // than a spurious add/remove pair.
    const before = snapshot([section("notes", "first", 0), section("notes", "second", 1)]);
    const after = snapshot([section("notes", "first", 0), section("notes", "second edited", 1)]);

    assert.deepEqual(
      diffKnowledgeSnapshots(before, after).map((draft) => draft.kind),
      ["section_changed"]
    );
  });
});
