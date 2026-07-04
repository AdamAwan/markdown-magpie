import { test } from "node:test";
import assert from "node:assert/strict";
import type { SourceDataContext } from "@magpie/core";
import { hashDocumentContent, hashSourceCorpus } from "./patrol-hash.js";

test("hashDocumentContent is stable for identical content and differs when it changes", () => {
  assert.equal(hashDocumentContent("# Doc\nbody"), hashDocumentContent("# Doc\nbody"));
  assert.notEqual(hashDocumentContent("# Doc\nbody"), hashDocumentContent("# Doc\nbody "));
});

function source(overrides: Partial<SourceDataContext>): SourceDataContext {
  return { sourceId: "s1", sourceName: "S1", kind: "local", ...overrides };
}

test("hashSourceCorpus is order-independent", () => {
  const a = source({ sourceId: "a", content: "alpha" });
  const b = source({ sourceId: "b", content: "beta" });
  assert.equal(hashSourceCorpus([a, b]), hashSourceCorpus([b, a]));
});

test("hashSourceCorpus changes when any source's content changes", () => {
  const before = [source({ sourceId: "a", content: "alpha" })];
  const after = [source({ sourceId: "a", content: "alpha edited" })];
  assert.notEqual(hashSourceCorpus(before), hashSourceCorpus(after));
});

test("hashSourceCorpus distinguishes content that only differs across a field boundary", () => {
  // Field-boundary robustness: two sources whose (path, content) split differently
  // must not collide just because a naive join would concatenate to the same string.
  const left = hashSourceCorpus([source({ path: "a", content: "bc" })]);
  const right = hashSourceCorpus([source({ path: "ab", content: "c" })]);
  assert.notEqual(left, right);
});

test("an empty corpus hashes to a stable value", () => {
  assert.equal(hashSourceCorpus([]), hashSourceCorpus([]));
});
