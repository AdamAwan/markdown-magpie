import { test } from "node:test";
import assert from "node:assert/strict";
import type { SourceDescriptor } from "@magpie/core";
import { hashDocumentContent, hashSourceDescriptors } from "./patrol-hash.js";

test("hashDocumentContent is stable for identical content and differs when it changes", () => {
  assert.equal(hashDocumentContent("# Doc\nbody"), hashDocumentContent("# Doc\nbody"));
  assert.notEqual(hashDocumentContent("# Doc\nbody"), hashDocumentContent("# Doc\nbody "));
});

function gitSource(overrides: Partial<Extract<SourceDescriptor, { kind: "git" }>>): SourceDescriptor {
  return { id: "s1", name: "S1", kind: "git", url: "https://example.com/repo.git", ...overrides };
}

test("hashSourceDescriptors is order-independent", () => {
  const a = gitSource({ id: "a" });
  const b = gitSource({ id: "b" });
  assert.equal(hashSourceDescriptors([a, b]), hashSourceDescriptors([b, a]));
});

test("hashSourceDescriptors changes when a descriptor is re-pointed or re-scoped", () => {
  const before = [gitSource({ url: "https://example.com/repo.git" })];
  const rePointed = [gitSource({ url: "https://example.com/other.git" })];
  assert.notEqual(hashSourceDescriptors(before), hashSourceDescriptors(rePointed));

  const scoped = [gitSource({ subpath: "Docs" })];
  const reScoped = [gitSource({ subpath: "Guides" })];
  assert.notEqual(hashSourceDescriptors(scoped), hashSourceDescriptors(reScoped));
  assert.notEqual(hashSourceDescriptors(before), hashSourceDescriptors(scoped));
});

test("hashSourceDescriptors re-arms on a fetch-allowlist change but not a reorder (#242)", () => {
  const internet = (allowedHosts?: string[]): SourceDescriptor => ({
    id: "i1",
    name: "Site",
    kind: "internet",
    url: "https://x.example",
    ...(allowedHosts ? { allowedHosts } : {})
  });
  assert.notEqual(hashSourceDescriptors([internet()]), hashSourceDescriptors([internet(["docs.x.example"])]));
  assert.notEqual(
    hashSourceDescriptors([internet(["docs.x.example"])]),
    hashSourceDescriptors([internet(["docs.x.example", "ref.x.example"])])
  );
  assert.equal(
    hashSourceDescriptors([internet(["a.example", "b.example"])]),
    hashSourceDescriptors([internet(["b.example", "a.example"])])
  );
});

test("an empty descriptor set hashes to a stable value", () => {
  assert.equal(hashSourceDescriptors([]), hashSourceDescriptors([]));
});

test("hashSourceDescriptors distinguishes values that only differ across a field boundary", () => {
  // Field-boundary robustness: two descriptors whose (name, url) split differently
  // must not collide just because a naive join would concatenate to the same string.
  const left = hashSourceDescriptors([gitSource({ name: "ab", url: "c" })]);
  const right = hashSourceDescriptors([gitSource({ name: "a", url: "bc" })]);
  assert.notEqual(left, right);
});
