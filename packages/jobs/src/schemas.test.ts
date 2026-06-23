import assert from "node:assert/strict";
import { test } from "node:test";
import { draftMarkdownProposalInputSchema } from "./schemas.js";

test("draft input schema preserves gapClusterId", () => {
  const parsed = draftMarkdownProposalInputSchema.parse({
    provider: "codex",
    gapSummaries: ["g"],
    triggeringQuestions: ["q"],
    evidence: [],
    expectedOutput: "markdown_proposal",
    gapClusterId: "cluster-1"
  });
  assert.equal(parsed.gapClusterId, "cluster-1");
});

test("draft input schema leaves gapClusterId absent when not provided", () => {
  const parsed = draftMarkdownProposalInputSchema.parse({
    provider: "codex",
    gapSummaries: ["g"],
    triggeringQuestions: ["q"],
    evidence: [],
    expectedOutput: "markdown_proposal"
  });
  assert.equal(parsed.gapClusterId, undefined);
});
