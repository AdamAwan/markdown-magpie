import { test } from "node:test";
import assert from "node:assert/strict";
import type { AiJob } from "@magpie/core";
import { buildJobPrompt } from "./build.js";
import {
  ANSWER_QUESTION,
  CRUNCH_KNOWLEDGE_BASE,
  DRAFT_MARKDOWN_PROPOSAL,
  GENERIC_JOB,
  SOURCE_CHANGE_SYNC,
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

test("answer_question embeds the question and routing flows after the instructions", () => {
  // The watcher (Task 7) retrieves context at run time and applies the routed
  // flow's persona; the job input now carries only the question and the routing
  // candidates.
  const input = { question: "What now?", flows: [{ id: "support", name: "Support" }] };
  const prompt = buildJobPrompt(job("answer_question", input));
  assert.equal(
    prompt,
    `${ANSWER_QUESTION.instructions}\n\nQuestion:\n${input.question}\n\nCandidate flows:\n${JSON.stringify(input.flows, null, 2)}`
  );
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

test("sync_source_change uses the source-change-sync prompt, not the generic fallback", () => {
  const input = { changes: [{ path: "src/a.ts", diff: "..." }], documents: [] };
  const prompt = buildJobPrompt(job("sync_source_change", input));
  assert.equal(prompt, `${SOURCE_CHANGE_SYNC.instructions}\n\nInput:\n${JSON.stringify(input, null, 2)}`);
});

test("unmapped job types fall back to the generic job prompt with the whole job", () => {
  const detectJob = job("detect_contradiction", { foo: 1 });
  const prompt = buildJobPrompt(detectJob);
  assert.equal(prompt, `${GENERIC_JOB.instructions}\n\nJob:\n${JSON.stringify(detectJob, null, 2)}`);
});
