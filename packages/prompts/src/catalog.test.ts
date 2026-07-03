import { test } from "node:test";
import assert from "node:assert/strict";
import { promptCatalog, getPrompt, withPersona, PERSONA_GROUNDING_GUARD } from "./catalog.js";

test("catalog has exactly 18 prompts", () => {
  assert.equal(promptCatalog.length, 18);
});

test("catalog ids are in the fixed, documented order", () => {
  assert.deepEqual(
    promptCatalog.map((prompt) => prompt.id),
    [
      "answer-question",
      "verify-answer",
      "summarize-gap",
      "draft-markdown-proposal",
      "draft-seed-document",
      "fold-markdown-proposal",
      "fold-changeset-proposal",
      "source-change-sync",
      "verify-document",
      "correct-document",
      "dedupe-documents",
      "split-document",
      "improve-document",
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
  assert.equal(getPrompt("source-change-sync")?.id, "source-change-sync");
  assert.equal(getPrompt("does-not-exist"), undefined);
});

// The answer prompt's anti-fabrication contract. These clauses are what stops the
// model asserting certifications, figures, or capabilities the retrieved context
// does not contain — a regression here reintroduces fabricated answers.
test("answer-question carries the grounding contract and confidence rubric", () => {
  const instructions = getPrompt("answer-question")?.instructions ?? "";
  assert.match(instructions, /ONLY source of facts/);
  assert.match(instructions, /NEVER supplement from general knowledge/);
  assert.match(instructions, /SOC 2, GDPR/, "names compliance claims as the canonical fabrication");
  assert.match(instructions, /never as\s+licence to invent/, "a sales question is not licence to invent");
  assert.match(
    instructions,
    /search\s+for it rather than asserting it/,
    "a tempting unsupported fact is searched for, and an empty search becomes a followup gap"
  );
  assert.match(instructions, /use "high" ONLY when every claim is directly supported/);
  assert.match(
    instructions,
    /Prefer searching to answering/,
    "the model is nudged to search rather than settle for a low-confidence first-round answer"
  );
});

test("withPersona appends the persona followed by the grounding guard", () => {
  const assembled = withPersona("BASE", "Friendly sales rep");
  assert.ok(assembled.startsWith("BASE\n\nPersona (how to look and respond):\nFriendly sales rep"));
  assert.ok(assembled.endsWith(PERSONA_GROUNDING_GUARD), "the guard gets the last word after the persona");
});

test("withPersona returns the base unchanged when no persona is set", () => {
  assert.equal(withPersona("BASE"), "BASE");
  assert.equal(withPersona("BASE", "   "), "BASE");
});
