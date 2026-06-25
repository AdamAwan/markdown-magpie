import { test } from "node:test";
import assert from "node:assert/strict";
import { promptCatalog, getPrompt } from "./catalog.js";

test("catalog has exactly 14 prompts", () => {
  assert.equal(promptCatalog.length, 14);
});

test("catalog ids are in the fixed, documented order", () => {
  assert.deepEqual(
    promptCatalog.map((prompt) => prompt.id),
    [
      "answer-question",
      "summarize-gap",
      "draft-markdown-proposal",
      "fold-markdown-proposal",
      "crunch-knowledge-base",
      "source-change-sync",
      "verify-document",
      "correct-document",
      "gap-clustering",
      "gap-reconcile-propose",
      "gap-reconcile-critic",
      "generic-job",
      "job-runner-system",
      "route-question-to-flow"
    ]
  );
});

test("all prompt ids are unique", () => {
  const ids = promptCatalog.map((prompt) => prompt.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("every prompt has non-empty required fields", () => {
  for (const prompt of promptCatalog) {
    assert.ok(prompt.id.length > 0, `id for ${prompt.title}`);
    assert.ok(prompt.title.length > 0, `title for ${prompt.id}`);
    assert.ok(prompt.description.length > 0, `description for ${prompt.id}`);
    assert.ok(prompt.outputShape.length > 0, `outputShape for ${prompt.id}`);
    assert.ok(prompt.instructions.length > 0, `instructions for ${prompt.id}`);
    assert.ok(Array.isArray(prompt.usedBy) && prompt.usedBy.length > 0, `usedBy for ${prompt.id}`);
  }
});

test("instructions never end with a trailing newline", () => {
  for (const prompt of promptCatalog) {
    assert.ok(!prompt.instructions.endsWith("\n"), `${prompt.id} has trailing newline`);
  }
});

test("getPrompt finds by id and returns undefined for unknown", () => {
  assert.equal(getPrompt("crunch-knowledge-base")?.id, "crunch-knowledge-base");
  assert.equal(getPrompt("does-not-exist"), undefined);
});
