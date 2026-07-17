import assert from "node:assert/strict";
import test from "node:test";
import { sectionFromPath } from "./sections";

test("exact section paths resolve to their section", () => {
  assert.equal(sectionFromPath("/questionnaires"), "questionnaires");
  assert.equal(sectionFromPath("/proposals"), "proposals");
  assert.equal(sectionFromPath("/source-map"), "source-map");
});

test("a nested detail path resolves to its parent section", () => {
  assert.equal(sectionFromPath("/questionnaires/qn-123"), "questionnaires");
  assert.equal(sectionFromPath("/questionnaires/qn-123/anything"), "questionnaires");
});

test("an unknown path falls back to the default section", () => {
  assert.equal(sectionFromPath("/"), "ask");
  assert.equal(sectionFromPath("/nope"), "ask");
});

test("a prefix only matches at a path boundary", () => {
  // A sibling that merely shares a string prefix must not be captured by another
  // section's path (guards against /source-map swallowing a /source-* sibling).
  assert.equal(sectionFromPath("/source-maps"), "ask");
});
