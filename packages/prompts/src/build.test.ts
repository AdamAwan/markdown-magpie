import { test } from "node:test";
import assert from "node:assert/strict";
import type { AiJob } from "@magpie/core";
import { buildJobPrompt } from "./build.js";
import {
  ANSWER_QUESTION,
  CRUNCH_KNOWLEDGE_BASE,
  DRAFT_MARKDOWN_PROPOSAL,
  GENERIC_JOB,
  SUMMARIZE_GAP
} from "./catalog.js";

function job(type: AiJob["type"], input: unknown): AiJob {
  return {
    id: "job-1",
    type,
    status: "pending",
    input,
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z"
  };
}

test("answer_question embeds question and context after the instructions", () => {
  const input = { question: "What now?", context: [{ heading: "H", content: "C" }] };
  const prompt = buildJobPrompt(job("answer_question", input));
  assert.equal(
    prompt,
    `${ANSWER_QUESTION.instructions}\n\nQuestion:\n${input.question}\n\nContext:\n${JSON.stringify(input.context, null, 2)}`
  );
});

test("answer_question appends the flow persona to the base instructions", () => {
  const input = { question: "What now?", context: [{ heading: "H", content: "C" }], persona: "Be concise and formal." };
  const prompt = buildJobPrompt(job("answer_question", input));
  assert.ok(
    prompt.startsWith(
      `${ANSWER_QUESTION.instructions}\n\nPersona (how to look and respond):\nBe concise and formal.`
    )
  );
  assert.match(prompt, /\n\nQuestion:\nWhat now\?/);
});

test("summarize_gap appends Input block", () => {
  const input = { questions: ["a", "b"] };
  const prompt = buildJobPrompt(job("summarize_gap", input));
  assert.equal(prompt, `${SUMMARIZE_GAP.instructions}\n\nInput:\n${JSON.stringify(input, null, 2)}`);
});

test("draft_markdown_proposal appends Input block", () => {
  const input = { gapSummaries: ["x"] };
  const prompt = buildJobPrompt(job("draft_markdown_proposal", input));
  assert.equal(prompt, `${DRAFT_MARKDOWN_PROPOSAL.instructions}\n\nInput:\n${JSON.stringify(input, null, 2)}`);
});

test("crunch_knowledge_base appends Input block", () => {
  const input = { documents: [{ path: "a.md", content: "c" }] };
  const prompt = buildJobPrompt(job("crunch_knowledge_base", input));
  assert.equal(prompt, `${CRUNCH_KNOWLEDGE_BASE.instructions}\n\nInput:\n${JSON.stringify(input, null, 2)}`);
});

test("unmapped job types fall back to the generic job prompt with the whole job", () => {
  const detectJob = job("detect_contradiction", { foo: 1 });
  const prompt = buildJobPrompt(detectJob);
  assert.equal(prompt, `${GENERIC_JOB.instructions}\n\nJob:\n${JSON.stringify(detectJob, null, 2)}`);
});
