import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnswerResult } from "@magpie/core";
import { InMemoryQuestionLogStore, gapSummaryKey } from "./question-log-store.js";

const lowGapAnswer: AnswerResult = {
  answer: "I could not find reliable source material.",
  confidence: "low",
  citations: [],
  gaps: [{ summary: "No source material for: vaccines", question: "vaccines?", confidence: "low", citedSectionIds: [], source: "auto" }]
};

const multiGapAnswer: AnswerResult = {
  answer: "The context covers setup but not React integration or dashboard export.",
  confidence: "low",
  citations: [],
  gaps: [
    { summary: "No React integration guidance", question: "react + export?", confidence: "low", citedSectionIds: [], source: "auto" },
    { summary: "Dashboard export is undocumented", question: "react + export?", confidence: "low", citedSectionIds: [], source: "auto" }
  ]
};

test("recordManualGap flags the question and stores the provided summary as a manual gap", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({ question: "How do I adopt?", chatProvider: "codex", retrievedSectionIds: [] });

  const updated = await store.recordManualGap(log.id, "Adoption process is undocumented");

  assert.equal(updated?.manualGap, true);
  assert.ok(updated?.manualGapAt);
  assert.deepEqual(updated?.gaps, [{ summary: "Adoption process is undocumented", source: "manual" }]);
});

test("recordManualGap defaults the summary to the question text", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({ question: "How do I adopt?", chatProvider: "codex", retrievedSectionIds: [] });

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
    chatProvider: "codex",
    answer: multiGapAnswer,
    retrievedSectionIds: []
  });

  assert.deepEqual(log.gaps, [
    { summary: "No React integration guidance", source: "auto" },
    { summary: "Dashboard export is undocumented", source: "auto" }
  ]);
  // Matches the Postgres column default (manual_gap NOT NULL DEFAULT false).
  assert.equal(log.manualGap, false);
});

test("recordManualGap preserves auto-detected gaps and adds a manual one", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({
    question: "react + export?",
    chatProvider: "codex",
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
    chatProvider: "codex",
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
  const log = await store.record({ question: "Partial answer?", chatProvider: "codex", answer: helpful, retrievedSectionIds: [] });
  await store.recordManualGap(log.id, "Needs a full guide");

  const candidates = await store.listGapCandidates(50);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].summary, "Needs a full guide");
  assert.deepEqual(candidates[0].questionIds, [log.id]);
});

test("listGapCandidates still includes auto-detected low-confidence gaps", async () => {
  const store = new InMemoryQuestionLogStore();
  await store.record({ question: "vaccines?", chatProvider: "codex", answer: lowGapAnswer, retrievedSectionIds: [] });

  const candidates = await store.listGapCandidates(50);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].summary, "No source material for: vaccines");
});

test("listGapCandidates lists each gap of a multi-topic question separately and clusters shared gaps", async () => {
  const store = new InMemoryQuestionLogStore();
  const first = await store.record({
    question: "react + export?",
    chatProvider: "codex",
    answer: multiGapAnswer,
    retrievedSectionIds: []
  });
  // A second question that only shares the dashboard-export gap.
  const second = await store.record({
    question: "how do I export a dashboard?",
    chatProvider: "codex",
    answer: {
      answer: "Not documented.",
      confidence: "low",
      citations: [],
      gaps: [{ summary: "Dashboard export is undocumented", question: "export?", confidence: "low", citedSectionIds: [], source: "auto" }]
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
    gaps: [{ summary: "Pricing is undocumented", question: "price?", confidence: "low", citedSectionIds: [], source: "auto" }]
  };
  const sales = await store.record({
    question: "price?",
    chatProvider: "codex",
    answer: sharedGap,
    retrievedSectionIds: [],
    flowId: "magpie-sales"
  });
  const support = await store.record({
    question: "price?",
    chatProvider: "codex",
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
  const log = await store.record({ question: "Partial answer?", chatProvider: "codex", answer: helpful, retrievedSectionIds: [] });
  await store.recordManualGap(log.id, "Needs a full guide");
  await store.clearManualGap(log.id);

  assert.equal((await store.listGapCandidates(50)).length, 0);
});

test("resolveGaps resolves only the matching gap and drops it from candidates", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({
    question: "react + export?",
    chatProvider: "codex",
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

test("gap catalog revision advances when a manual gap is recorded and when gaps resolve", async () => {
  const store = new InMemoryQuestionLogStore();
  const start = await store.getGapCatalogRevision();

  const log = await store.record({
    question: "How do I configure X?",
    chatProvider: "codex",
    retrievedSectionIds: []
  });
  await store.recordManualGap(log.id, "How to configure X");

  const afterAdd = await store.getGapCatalogRevision();
  assert.ok(afterAdd > start, "recording a gap advances the revision");

  await store.resolveGaps([log.id], ["How to configure X"], "prop-1");
  const afterResolve = await store.getGapCatalogRevision();
  assert.ok(afterResolve > afterAdd, "resolving a gap advances the revision");
});

test("gapIdsForSummary returns one stable id per unresolved gap matching the summary", async () => {
  const store = new InMemoryQuestionLogStore();
  const a = await store.record({ question: "q1?", chatProvider: "codex", retrievedSectionIds: [] });
  await store.recordManualGap(a.id, "How to configure X");
  const b = await store.record({ question: "q2?", chatProvider: "codex", retrievedSectionIds: [] });
  await store.recordManualGap(b.id, "How to configure X");

  const ids = await store.gapIdsForSummary("How to configure X");
  assert.equal(ids.length, 2, "two distinct questions share the summary");
  assert.equal(new Set(ids).size, 2, "ids are distinct per gap");

  // Resolving one gap drops it from the matches.
  await store.resolveGaps([a.id], ["How to configure X"], "prop-1");
  assert.deepEqual(await store.gapIdsForSummary("How to configure X"), [`${b.id}::How to configure X`]);
});

test("gapIdsForSummaries batches many pairs and matches gapIdsForSummary per pair", async () => {
  const store = new InMemoryQuestionLogStore();
  // Two questions share summary X in the default flow; one question has summary Y
  // in flow f1. The same summary X under f1 has no gaps.
  const a = await store.record({ question: "q1?", chatProvider: "codex", retrievedSectionIds: [] });
  await store.recordManualGap(a.id, "X");
  const b = await store.record({ question: "q2?", chatProvider: "codex", retrievedSectionIds: [] });
  await store.recordManualGap(b.id, "X");
  const c = await store.record({ question: "q3?", chatProvider: "codex", retrievedSectionIds: [], flowId: "f1" });
  await store.recordManualGap(c.id, "Y");

  const result = await store.gapIdsForSummaries([
    { summary: "X" },
    { summary: "Y", flowId: "f1" },
    { summary: "X", flowId: "f1" }
  ]);

  // Each pair resolves to exactly what the single-summary variant returns.
  assert.deepEqual(
    result.get(gapSummaryKey("X"))?.sort(),
    (await store.gapIdsForSummary("X")).sort()
  );
  assert.deepEqual(result.get(gapSummaryKey("Y", "f1")), await store.gapIdsForSummary("Y", "f1"));
  // A pair with no matching gaps is present with an empty array.
  assert.deepEqual(result.get(gapSummaryKey("X", "f1")), []);
});

test("resolveGaps is idempotent and only counts newly resolved gaps", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({
    question: "vaccines?",
    chatProvider: "codex",
    answer: lowGapAnswer,
    retrievedSectionIds: []
  });

  assert.equal(await store.resolveGaps([log.id], ["No source material for: vaccines"], "proposal-1"), 1);
  // Re-resolving the same gap changes nothing and reports zero new resolutions.
  assert.equal(await store.resolveGaps([log.id], ["No source material for: vaccines"], "proposal-2"), 0);
  assert.equal((await store.listGapCandidates(50)).length, 0);
});
