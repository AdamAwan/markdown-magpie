import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnswerResult } from "@magpie/core";
import { InMemoryQuestionLogStore } from "./question-log-store.js";

const lowGapAnswer: AnswerResult = {
  answer: "I could not find reliable source material.",
  confidence: "low",
  citations: [],
  gaps: [{ summary: "No source material for: vaccines", question: "vaccines?", confidence: "low", citedSectionIds: [] }]
};

const multiGapAnswer: AnswerResult = {
  answer: "The context covers setup but not React integration or dashboard export.",
  confidence: "low",
  citations: [],
  gaps: [
    { summary: "No React integration guidance", question: "react + export?", confidence: "low", citedSectionIds: [] },
    { summary: "Dashboard export is undocumented", question: "react + export?", confidence: "low", citedSectionIds: [] }
  ]
};

test("recordManualGap flags the question and stores the provided summary as a manual gap", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({ question: "How do I adopt?", executionMode: "direct", chatProvider: "mock", retrievedSectionIds: [] });

  const updated = await store.recordManualGap(log.id, "Adoption process is undocumented");

  assert.equal(updated?.manualGap, true);
  assert.ok(updated?.manualGapAt);
  assert.deepEqual(updated?.gaps, [{ summary: "Adoption process is undocumented", source: "manual" }]);
});

test("recordManualGap defaults the summary to the question text", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({ question: "How do I adopt?", executionMode: "direct", chatProvider: "mock", retrievedSectionIds: [] });

  const updated = await store.recordManualGap(log.id);

  assert.deepEqual(updated?.gaps, [{ summary: "How do I adopt?", source: "manual" }]);
});

test("recordManualGap returns undefined for an unknown question", async () => {
  const store = new InMemoryQuestionLogStore();
  assert.equal(await store.recordManualGap("missing"), undefined);
});

test("record stores one gap per detected gap for a multi-topic question", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({
    question: "react + export?",
    executionMode: "direct",
    chatProvider: "mock",
    answer: multiGapAnswer,
    retrievedSectionIds: []
  });

  assert.deepEqual(log.gaps, [
    { summary: "No React integration guidance", source: "auto" },
    { summary: "Dashboard export is undocumented", source: "auto" }
  ]);
});

test("recordManualGap preserves auto-detected gaps and adds a manual one", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({
    question: "react + export?",
    executionMode: "direct",
    chatProvider: "mock",
    answer: multiGapAnswer,
    retrievedSectionIds: []
  });

  const updated = await store.recordManualGap(log.id, "Also missing auth setup");

  assert.deepEqual(updated?.gaps, [
    { summary: "No React integration guidance", source: "auto" },
    { summary: "Dashboard export is undocumented", source: "auto" },
    { summary: "Also missing auth setup", source: "manual" }
  ]);
});

test("clearManualGap removes the manual gap but keeps auto-detected gaps", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({
    question: "react + export?",
    executionMode: "direct",
    chatProvider: "mock",
    answer: multiGapAnswer,
    retrievedSectionIds: []
  });
  await store.recordManualGap(log.id, "Also missing auth setup");

  const cleared = await store.clearManualGap(log.id);

  assert.equal(cleared?.manualGap, false);
  assert.equal(cleared?.manualGapAt, undefined);
  assert.deepEqual(cleared?.gaps, [
    { summary: "No React integration guidance", source: "auto" },
    { summary: "Dashboard export is undocumented", source: "auto" }
  ]);
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

test("listGapCandidates lists each gap of a multi-topic question separately and clusters shared gaps", async () => {
  const store = new InMemoryQuestionLogStore();
  const first = await store.record({
    question: "react + export?",
    executionMode: "direct",
    chatProvider: "mock",
    answer: multiGapAnswer,
    retrievedSectionIds: []
  });
  // A second question that only shares the dashboard-export gap.
  const second = await store.record({
    question: "how do I export a dashboard?",
    executionMode: "direct",
    chatProvider: "mock",
    answer: {
      answer: "Not documented.",
      confidence: "low",
      citations: [],
      gaps: [{ summary: "Dashboard export is undocumented", question: "export?", confidence: "low", citedSectionIds: [] }]
    },
    retrievedSectionIds: []
  });

  const candidates = await store.listGapCandidates(50);
  const bySummary = new Map(candidates.map((candidate) => [candidate.summary, candidate]));

  assert.equal(candidates.length, 2);
  assert.equal(bySummary.get("No React integration guidance")?.count, 1);
  const shared = bySummary.get("Dashboard export is undocumented");
  assert.equal(shared?.count, 2);
  assert.deepEqual([...(shared?.questionIds ?? [])].sort(), [first.id, second.id].sort());
});

test("listGapCandidates groups the same gap separately per flow and tags each candidate", async () => {
  const store = new InMemoryQuestionLogStore();
  const sharedGap: AnswerResult = {
    answer: "Not documented.",
    confidence: "low",
    citations: [],
    gaps: [{ summary: "Pricing is undocumented", question: "price?", confidence: "low", citedSectionIds: [] }]
  };
  const sales = await store.record({
    question: "price?",
    executionMode: "direct",
    chatProvider: "mock",
    answer: sharedGap,
    retrievedSectionIds: [],
    flowId: "magpie-sales"
  });
  const support = await store.record({
    question: "price?",
    executionMode: "direct",
    chatProvider: "mock",
    answer: sharedGap,
    retrievedSectionIds: [],
    flowId: "magpie-support"
  });

  const candidates = await store.listGapCandidates(50);
  const byFlow = new Map(candidates.map((candidate) => [candidate.flowId, candidate]));

  // Same summary, two flows -> two candidates, each tagged and scoped to its flow.
  assert.equal(candidates.length, 2);
  assert.deepEqual(byFlow.get("magpie-sales")?.questionIds, [sales.id]);
  assert.deepEqual(byFlow.get("magpie-support")?.questionIds, [support.id]);
});

test("listGapCandidates excludes a question whose manual gap was cleared", async () => {
  const store = new InMemoryQuestionLogStore();
  const helpful: AnswerResult = { answer: "Yes.", confidence: "high", citations: [] };
  const log = await store.record({ question: "Partial answer?", executionMode: "direct", chatProvider: "mock", answer: helpful, retrievedSectionIds: [] });
  await store.recordManualGap(log.id, "Needs a full guide");
  await store.clearManualGap(log.id);

  assert.equal((await store.listGapCandidates(50)).length, 0);
});

test("resolveGaps resolves only the matching gap and drops it from candidates", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({
    question: "react + export?",
    executionMode: "direct",
    chatProvider: "mock",
    answer: multiGapAnswer,
    retrievedSectionIds: []
  });

  const resolved = await store.resolveGaps([log.id], ["No React integration guidance"], "proposal-1");
  assert.equal(resolved, 1);

  const candidates = await store.listGapCandidates(50);
  // The resolved gap is gone; the untouched gap on the same question survives.
  assert.deepEqual(
    candidates.map((candidate) => candidate.summary),
    ["Dashboard export is undocumented"]
  );

  const stored = await store.get(log.id);
  const resolvedGap = stored?.gaps?.find((gap) => gap.summary === "No React integration guidance");
  assert.equal(resolvedGap?.resolvedByProposalId, "proposal-1");
  assert.ok(resolvedGap?.resolvedAt);
});

test("resolveGaps is idempotent and only counts newly resolved gaps", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({
    question: "vaccines?",
    executionMode: "direct",
    chatProvider: "mock",
    answer: lowGapAnswer,
    retrievedSectionIds: []
  });

  assert.equal(await store.resolveGaps([log.id], ["No source material for: vaccines"], "proposal-1"), 1);
  // Re-resolving the same gap changes nothing and reports zero new resolutions.
  assert.equal(await store.resolveGaps([log.id], ["No source material for: vaccines"], "proposal-2"), 0);
  assert.equal((await store.listGapCandidates(50)).length, 0);
});
