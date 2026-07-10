import { test } from "node:test";
import assert from "node:assert/strict";
import { promptCatalog, getPrompt, withPersona, PERSONA_GROUNDING_GUARD } from "./catalog.js";

test("catalog has exactly 19 prompts", () => {
  assert.equal(promptCatalog.length, 19);
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
      "outline-flow-seed",
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

test("source-grounded prompts describe source-map hints and contributions", () => {
  for (const id of ["draft-markdown-proposal", "draft-seed-document", "verify-document", "correct-document", "improve-document"]) {
    const prompt = getPrompt(id);
    assert.ok(prompt?.instructions.includes("Source map hints"), `${id} explains the hint block`);
    assert.ok(prompt?.instructions.includes("mapUpdates"), `${id} instructs mapUpdates contributions`);
    assert.ok(prompt?.outputShape.includes("mapUpdates"), `${id} outputShape mentions mapUpdates`);
  }
});

// The factual-register contract (#213): every prompt that authors or rewrites KB
// document markdown must carry the shared register clause forbidding self-authored
// advisory content (recommendations, next steps, roadmaps, editorial commentary)
// while still allowing a document to DESCRIBE a plan a source itself states.
const CONTENT_PRODUCING_PROMPT_IDS = [
  "draft-markdown-proposal",
  "draft-seed-document",
  "fold-markdown-proposal",
  "fold-changeset-proposal",
  "source-change-sync",
  "correct-document",
  "improve-document"
];

test("every content-producing prompt carries the factual-register contract", () => {
  for (const id of CONTENT_PRODUCING_PROMPT_IDS) {
    const instructions = getPrompt(id)?.instructions ?? "";
    assert.match(instructions, /factual and descriptive/, `${id} misses the register clause`);
    assert.match(instructions, /NEVER author your own recommendations/, `${id} misses the advisory ban`);
    assert.match(instructions, /IS allowed/, `${id} misses the source-stated-plan exception`);
  }
});

// #214: per-claim citations go to the structured provenance field — the document
// body must contain NO repository paths, so internal source locations can never
// leak into answers built from the document.
test("draft prompts require structured provenance and forbid inline path citations", () => {
  for (const id of ["draft-markdown-proposal", "draft-seed-document"]) {
    const prompt = getPrompt(id);
    assert.ok(prompt?.instructions.includes('"provenance"'), `${id} instructs the provenance array`);
    assert.ok(
      !/cite their repository paths (in the text|\(e\.g\.)/.test(prompt?.instructions ?? ""),
      `${id} no longer instructs inline body citations`
    );
    assert.ok(prompt?.outputShape.includes("provenance"), `${id} outputShape mentions provenance`);
  }
});

// #214 phase 3: the rewrite jobs document their own diffs — per-claim citations
// move from the prose rationale to the structured provenance field, so the
// corrective/improvement proposal rows become provenance events too.
test("rewrite prompts require structured provenance instead of rationale citations", () => {
  for (const id of ["correct-document", "improve-document", "fold-markdown-proposal"]) {
    const prompt = getPrompt(id);
    assert.ok(prompt?.instructions.includes('"provenance"'), `${id} instructs the provenance array`);
    assert.doesNotMatch(
      prompt?.instructions ?? "",
      /repository paths in the rationale/,
      `${id} no longer routes citations to the rationale`
    );
    assert.ok(prompt?.outputShape.includes("provenance"), `${id} outputShape mentions provenance`);
  }
  const improve = getPrompt("improve-document")?.instructions ?? "";
  assert.doesNotMatch(
    improve,
    /which repository paths support it/,
    "improve's rationale rule no longer asks for paths"
  );
  assert.match(
    improve,
    /"improved" is false, omit "provenance"/,
    "improve scopes provenance to the improved: true output"
  );
});

// #214 cleanup: pre-feature documents may still carry inline "(see ...)" source
// citations from the old draft prompts. The verify→correct patrol strips them
// organically: verify flags each as a claim, correct removes the parenthetical
// as a formatting defect without touching the factual content.
test("the verify→correct patrol flags and strips legacy inline source-path citations", () => {
  const verify = getPrompt("verify-document")?.instructions ?? "";
  assert.match(verify, /[Ii]nline repository-path citations?/, "verify names the defect");
  assert.match(verify, /inline source-path citation/, "verify prescribes the claim reason");
  const correct = getPrompt("correct-document")?.instructions ?? "";
  assert.match(correct, /inline source-path citation/, "correct recognises the flagged reason");
  assert.match(correct, /formatting defect/, "correct treats it as formatting, not a factual error");
  assert.match(correct, /do not change the factual content/, "correct leaves the facts alone");
});

// #214 phase 2: verify receives advisory citedClaims (the provenance folded
// from the document's merged proposals) and checks each against its cited
// location FIRST, distinguishing "cited support changed" from a claim that was
// never provable; claims without provenance re-derive as before, and the
// sources always win over the advisory input.
test("verify checks citedClaims against their cited locations first", () => {
  const verify = getPrompt("verify-document")?.instructions ?? "";
  assert.match(verify, /citedClaims/, "verify names the input field");
  assert.match(verify, /cited support changed:/, "verify prescribes the cited-support-changed reason prefix");
  assert.match(verify, /NOT in citedClaims/, "unlisted claims fall back to full re-derivation");
  assert.match(verify, /advisory/, "citedClaims is advisory — the sources win on conflict");
});

// #213: uncovered points are OMITTED from the document body and reported in the
// structured uncoveredPoints field — never written into the markdown as notes.
test("draft prompts route uncovered points to uncoveredPoints, not the document body", () => {
  for (const id of ["draft-markdown-proposal", "draft-seed-document"]) {
    const instructions = getPrompt(id)?.instructions ?? "";
    assert.doesNotMatch(instructions, /note the gap plainly/, `${id} still writes gaps into the body`);
    assert.doesNotMatch(instructions, /say so plainly/, `${id} still writes gaps into the body`);
    assert.match(instructions, /OMIT it from the document entirely/, `${id} misses the omission rule`);
    assert.match(instructions, /"uncoveredPoints"/, `${id} misses the reporting field`);
  }
});
