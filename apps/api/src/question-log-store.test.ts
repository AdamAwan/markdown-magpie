import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnswerResult } from "@magpie/core";
import { InMemoryQuestionLogStore } from "./question-log-store.js";

const lowGapAnswer: AnswerResult = {
  answer: "I could not find reliable source material.",
  confidence: "low",
  citations: [],
  gap: { summary: "No source material for: vaccines", question: "vaccines?", confidence: "low", citedSectionIds: [] }
};

test("recordManualGap flags the question and stores the provided summary", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({ question: "How do I adopt?", executionMode: "direct", chatProvider: "mock", retrievedSectionIds: [] });

  const updated = await store.recordManualGap(log.id, "Adoption process is undocumented");

  assert.equal(updated?.manualGap, true);
  assert.ok(updated?.manualGapAt);
  assert.equal(updated?.gapSummary, "Adoption process is undocumented");
});

test("recordManualGap defaults the summary to the question text", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({ question: "How do I adopt?", executionMode: "direct", chatProvider: "mock", retrievedSectionIds: [] });

  const updated = await store.recordManualGap(log.id);

  assert.equal(updated?.gapSummary, "How do I adopt?");
});

test("recordManualGap returns undefined for an unknown question", async () => {
  const store = new InMemoryQuestionLogStore();
  assert.equal(await store.recordManualGap("missing"), undefined);
});

test("clearManualGap unsets the flag but keeps the gap summary", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({ question: "How do I adopt?", executionMode: "direct", chatProvider: "mock", retrievedSectionIds: [] });
  await store.recordManualGap(log.id, "Adoption undocumented");

  const cleared = await store.clearManualGap(log.id);

  assert.equal(cleared?.manualGap, false);
  assert.equal(cleared?.manualGapAt, undefined);
  assert.equal(cleared?.gapSummary, "Adoption undocumented");
});

test("listGapCandidates includes a manually flagged high-confidence question", async () => {
  const store = new InMemoryQuestionLogStore();
  const helpful: AnswerResult = { answer: "Yes.", confidence: "high", citations: [] };
  const log = await store.record({ question: "Partial answer?", executionMode: "direct", chatProvider: "mock", answer: helpful, retrievedSectionIds: [] });
  await store.recordManualGap(log.id, "Needs a full guide");

  const candidates = await store.listGapCandidates(50);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].summary, "Needs a full guide");
  assert.deepEqual(candidates[0].questionIds, [log.id]);
});

test("listGapCandidates still includes auto-detected low-confidence gaps", async () => {
  const store = new InMemoryQuestionLogStore();
  await store.record({ question: "vaccines?", executionMode: "direct", chatProvider: "mock", answer: lowGapAnswer, retrievedSectionIds: [] });

  const candidates = await store.listGapCandidates(50);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].summary, "No source material for: vaccines");
});

test("listGapCandidates excludes a question whose manual gap was cleared", async () => {
  const store = new InMemoryQuestionLogStore();
  const helpful: AnswerResult = { answer: "Yes.", confidence: "high", citations: [] };
  const log = await store.record({ question: "Partial answer?", executionMode: "direct", chatProvider: "mock", answer: helpful, retrievedSectionIds: [] });
  await store.recordManualGap(log.id, "Needs a full guide");
  await store.clearManualGap(log.id);

  assert.equal((await store.listGapCandidates(50)).length, 0);
});
