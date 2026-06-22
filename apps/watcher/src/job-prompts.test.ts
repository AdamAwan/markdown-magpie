import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JobView } from "@magpie/jobs";
import type { RetrievedSection } from "./http-client.js";
import { buildAnswerOutput, buildPrompt, parseJobOutput } from "./job-prompts.js";

function job(type: JobView["type"], input: unknown): JobView {
  return {
    id: "j",
    type,
    queueName: type,
    deadLetter: false,
    state: "active",
    input,
    retryCount: 0,
    retryLimit: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expireInSeconds: 300
  };
}

const SECTIONS: RetrievedSection[] = [
  {
    sectionId: "doc-1#deploy",
    documentId: "doc-1",
    anchor: "deploy",
    path: "ops/deploy.md",
    heading: "Deploy",
    content: "Run the deploy script then verify health."
  }
];

describe("buildPrompt", () => {
  it("embeds the summarize_gap input as JSON", () => {
    const prompt = buildPrompt(job("summarize_gap", { questions: ["why?"], citedSections: [] }));
    assert.match(prompt, /why\?/);
  });
});

describe("buildAnswerOutput", () => {
  it("derives citations from the retrieved sections, not the model", () => {
    const output = buildAnswerOutput(
      JSON.stringify({ answer: "Deploy then verify.", confidence: "high", isKnowledgeGap: false }),
      SECTIONS,
      "How do I deploy?",
      "flow-1"
    );
    assert.equal(output.answer, "Deploy then verify.");
    assert.equal(output.confidence, "high");
    assert.equal(output.flowId, "flow-1");
    assert.equal(output.citations.length, 1);
    assert.deepEqual(output.citations[0], {
      documentId: "doc-1",
      sectionId: "doc-1#deploy",
      path: "ops/deploy.md",
      heading: "Deploy",
      anchor: "deploy",
      excerpt: "Run the deploy script then verify health."
    });
  });

  it("forces low confidence and emits a gap when the model flags a knowledge gap", () => {
    const output = buildAnswerOutput(
      JSON.stringify({ answer: "Not covered.", confidence: "high", isKnowledgeGap: true, gaps: ["no rollback docs"] }),
      SECTIONS,
      "How do I roll back?",
      undefined
    );
    assert.equal(output.confidence, "low");
    assert.ok(output.gaps && output.gaps.length === 1);
    assert.equal(output.gaps[0].summary, "no rollback docs");
    assert.equal(output.gaps[0].question, "How do I roll back?");
    assert.deepEqual(output.gaps[0].citedSectionIds, ["doc-1#deploy"]);
    assert.equal(output.flowId, undefined);
  });
});

describe("parseJobOutput", () => {
  it("validates summarize_gap output against the job contract", () => {
    const parsed = parseJobOutput(
      job("summarize_gap", {}),
      JSON.stringify({ summary: "s", priority: 2, rationale: "r" })
    );
    assert.deepEqual(parsed, { summary: "s", priority: 2, rationale: "r" });
  });

  it("rejects output that does not match the contract", () => {
    assert.throws(() => parseJobOutput(job("summarize_gap", {}), JSON.stringify({ summary: "s" })));
  });

  it("extracts a JSON object embedded in surrounding prose", () => {
    const parsed = parseJobOutput(
      job("summarize_gap", {}),
      `Sure! Here is the result:\n{"summary":"s","priority":1,"rationale":"r"}\nThanks.`
    );
    assert.deepEqual(parsed, { summary: "s", priority: 1, rationale: "r" });
  });
});
