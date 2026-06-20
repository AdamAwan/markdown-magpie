import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { AnswerResult } from "@magpie/core";
import { PostgresQuestionLogStore } from "./postgres-question-log-store.js";

// Integration tests for the Postgres-backed question log store. They self-skip
// unless DATABASE_URL points at a migrated database (see scripts/migrate.mjs);
// CI provides one via a pgvector service container. This is modeled on the
// postgres-proposal-store.test.ts template — round-trip through real SQL and
// assert by the ids you created so parallel rows never make the suite flaky.
const databaseUrl = process.env.DATABASE_URL;

function lowConfidenceAnswer(): AnswerResult {
  return {
    answer: "I could not find reliable source material.",
    confidence: "low",
    citations: [],
    gaps: [{ summary: "No source material available", question: "test?", confidence: "low", citedSectionIds: [] }]
  };
}

function multiGapAnswer(): AnswerResult {
  return {
    answer: "Partial information available.",
    confidence: "low",
    citations: [],
    gaps: [
      { summary: "First gap summary", question: "test?", confidence: "low", citedSectionIds: [] },
      { summary: "Second gap summary", question: "test?", confidence: "low", citedSectionIds: [] }
    ]
  };
}

describe("PostgresQuestionLogStore", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  const store = new PostgresQuestionLogStore(databaseUrl as string);

  it("round-trips a question through record and get", async () => {
    const uniqueId = randomUUID();
    const recorded = await store.record({
      question: `test-roundtrip-${uniqueId}`,
      executionMode: "direct",
      chatProvider: "mock",
      retrievedSectionIds: [],
      answer: lowConfidenceAnswer()
    });

    assert.ok(recorded.id);
    assert.equal(recorded.question, `test-roundtrip-${uniqueId}`);
    assert.equal(recorded.executionMode, "direct");
    assert.equal(recorded.chatProvider, "mock");
    assert.equal(recorded.manualGap, false);
    assert.ok((recorded.gaps ?? []).length > 0);

    const fetched = await store.get(recorded.id);
    assert.equal(fetched?.id, recorded.id);
    assert.equal(fetched?.question, recorded.question);
    assert.equal(fetched?.confidence, "low");
  });

  it("stores auto-detected gaps when recording with an answer", async () => {
    const uniqueId = randomUUID();
    const recorded = await store.record({
      question: `test-gaps-${uniqueId}`,
      executionMode: "direct",
      chatProvider: "mock",
      retrievedSectionIds: [],
      answer: multiGapAnswer()
    });

    assert.equal((recorded.gaps ?? []).length, 2);
    assert.ok((recorded.gaps ?? []).some((gap) => gap.summary === "First gap summary" && gap.source === "auto"));
    assert.ok((recorded.gaps ?? []).some((gap) => gap.summary === "Second gap summary" && gap.source === "auto"));
  });

  it("records feedback on an existing question", async () => {
    const uniqueId = randomUUID();
    const recorded = await store.record({
      question: `test-feedback-${uniqueId}`,
      executionMode: "direct",
      chatProvider: "mock",
      retrievedSectionIds: []
    });

    const updated = await store.recordFeedback(recorded.id, "unhelpful");
    assert.equal(updated?.feedback, "unhelpful");
    assert.ok(updated?.feedbackAt);

    const fetched = await store.get(recorded.id);
    assert.equal(fetched?.feedback, "unhelpful");
  });

  it("records a manual gap with a provided summary", async () => {
    const uniqueId = randomUUID();
    const recorded = await store.record({
      question: `test-manual-gap-${uniqueId}`,
      executionMode: "direct",
      chatProvider: "mock",
      retrievedSectionIds: []
    });

    const updated = await store.recordManualGap(recorded.id, "Manual gap summary for testing");
    assert.equal(updated?.manualGap, true);
    assert.ok(updated?.manualGapAt);
    assert.ok((updated?.gaps ?? []).some((gap) => gap.summary === "Manual gap summary for testing" && gap.source === "manual"));
  });

  it("records a manual gap defaulting to the question text when no summary provided", async () => {
    const uniqueId = randomUUID();
    const questionText = `test-manual-default-${uniqueId}`;
    const recorded = await store.record({
      question: questionText,
      executionMode: "direct",
      chatProvider: "mock",
      retrievedSectionIds: []
    });

    const updated = await store.recordManualGap(recorded.id);
    assert.equal(updated?.manualGap, true);
    assert.ok((updated?.gaps ?? []).some((gap) => gap.summary === questionText && gap.source === "manual"));
  });

  it("clears a manual gap and preserves auto-detected gaps", async () => {
    const uniqueId = randomUUID();
    const recorded = await store.record({
      question: `test-clear-gap-${uniqueId}`,
      executionMode: "direct",
      chatProvider: "mock",
      retrievedSectionIds: [],
      answer: multiGapAnswer()
    });

    await store.recordManualGap(recorded.id, "Manual gap to clear");
    const cleared = await store.clearManualGap(recorded.id);

    assert.equal(cleared?.manualGap, false);
    assert.equal(cleared?.manualGapAt, undefined);
    // Manual gap removed, auto-detected gaps remain
    assert.equal((cleared?.gaps ?? []).filter((gap) => gap.source === "auto").length, 2);
    assert.equal((cleared?.gaps ?? []).filter((gap) => gap.source === "manual").length, 0);
  });

  it("updates an answer and replaces auto-detected gaps while preserving manual flags", async () => {
    const uniqueId = randomUUID();
    const recorded = await store.record({
      question: `test-update-answer-${uniqueId}`,
      executionMode: "direct",
      chatProvider: "mock",
      retrievedSectionIds: [],
      answer: lowConfidenceAnswer()
    });

    await store.recordManualGap(recorded.id, "Manual gap to preserve");

    const newAnswer: AnswerResult = {
      answer: "Updated answer.",
      confidence: "high",
      citations: [],
      gaps: [{ summary: "New auto gap", question: "test?", confidence: "low", citedSectionIds: [] }]
    };

    const updated = await store.updateAnswer(recorded.id, {
      answer: newAnswer,
      chatProvider: "mock"
    });

    assert.equal(updated?.confidence, "high");
    assert.ok((updated?.gaps ?? []).some((gap) => gap.summary === "Manual gap to preserve" && gap.source === "manual"));
    assert.ok((updated?.gaps ?? []).some((gap) => gap.summary === "New auto gap" && gap.source === "auto"));
  });

  it("returns undefined when updating feedback on a non-existent question", async () => {
    const result = await store.recordFeedback("00000000-0000-0000-0000-000000000000", "unhelpful");
    assert.equal(result, undefined);
  });

  it("returns undefined when recording a manual gap on a non-existent question", async () => {
    const result = await store.recordManualGap("00000000-0000-0000-0000-000000000000", "test");
    assert.equal(result, undefined);
  });

  it("returns undefined when clearing a manual gap on a non-existent question", async () => {
    const result = await store.clearManualGap("00000000-0000-0000-0000-000000000000");
    assert.equal(result, undefined);
  });

  it("lists questions ordered by recency with a high limit", async () => {
    const uniqueId = randomUUID();
    const first = await store.record({
      question: `test-list-1-${uniqueId}`,
      executionMode: "direct",
      chatProvider: "mock",
      retrievedSectionIds: []
    });

    const second = await store.record({
      question: `test-list-2-${uniqueId}`,
      executionMode: "direct",
      chatProvider: "mock",
      retrievedSectionIds: []
    });

    const listed = await store.list(200);
    const listIds = listed.map((q) => q.id);

    assert.ok(listIds.includes(first.id), "first question should be in the list");
    assert.ok(listIds.includes(second.id), "second question should be in the list");
    // Most recent should come first
    const secondIndex = listIds.indexOf(second.id);
    const firstIndex = listIds.indexOf(first.id);
    assert.ok(secondIndex < firstIndex, "second question should appear before first in the list");
  });

  it("resolves gaps by question id and summary", async () => {
    const uniqueId = randomUUID();
    const recorded = await store.record({
      question: `test-resolve-${uniqueId}`,
      executionMode: "direct",
      chatProvider: "mock",
      retrievedSectionIds: [],
      answer: multiGapAnswer()
    });

    const proposalId = randomUUID();
    const resolved = await store.resolveGaps([recorded.id], ["First gap summary"], proposalId);
    assert.equal(resolved, 1);

    const fetched = await store.get(recorded.id);
    const resolvedGap = fetched?.gaps?.find((gap) => gap.summary === "First gap summary");
    assert.ok(resolvedGap?.resolvedAt);
    assert.equal(resolvedGap?.resolvedByProposalId, proposalId);
  });

  it("listGapCandidates includes low-confidence auto-detected gaps", async () => {
    const uniqueId = randomUUID();
    await store.record({
      question: `test-candidate-${uniqueId}`,
      executionMode: "direct",
      chatProvider: "mock",
      retrievedSectionIds: [],
      answer: lowConfidenceAnswer()
    });

    const candidates = await store.listGapCandidates(200);
    const found = candidates.some((candidate) => candidate.summary === "No source material available");

    assert.ok(found, "low-confidence gap should appear in candidates");
  });

  it("listGapCandidates includes manually flagged questions regardless of confidence", async () => {
    const uniqueId = randomUUID();
    const recorded = await store.record({
      question: `test-manual-candidate-${uniqueId}`,
      executionMode: "direct",
      chatProvider: "mock",
      retrievedSectionIds: [],
      answer: {
        answer: "Complete answer.",
        confidence: "high",
        citations: [],
        gaps: []
      }
    });

    await store.recordManualGap(recorded.id, "Manually flagged as incomplete");

    const candidates = await store.listGapCandidates(200);
    const found = candidates.some((candidate) => candidate.summary === "Manually flagged as incomplete");

    assert.ok(found, "manually flagged high-confidence question should appear in candidates");
  });

  it("listGapCandidates groups the same gap across multiple questions", async () => {
    const uniqueId = randomUUID();
    // Unique so the candidate count reflects only this test's two questions,
    // not leftover or parallel rows that happen to share a static summary.
    const sharedGap = `Shared gap ${uniqueId}`;
    const first = await store.record({
      question: `test-shared-1-${uniqueId}`,
      executionMode: "direct",
      chatProvider: "mock",
      retrievedSectionIds: [],
      answer: {
        answer: "Answer.",
        confidence: "low",
        citations: [],
        gaps: [{ summary: sharedGap, question: "test?", confidence: "low", citedSectionIds: [] }]
      }
    });

    const second = await store.record({
      question: `test-shared-2-${uniqueId}`,
      executionMode: "direct",
      chatProvider: "mock",
      retrievedSectionIds: [],
      answer: {
        answer: "Answer.",
        confidence: "low",
        citations: [],
        gaps: [{ summary: sharedGap, question: "test?", confidence: "low", citedSectionIds: [] }]
      }
    });

    const candidates = await store.listGapCandidates(200);
    const found = candidates.find((candidate) => candidate.summary === sharedGap);

    assert.ok(found, "shared gap should appear in candidates");
    assert.ok(found.questionIds.includes(first.id), "first question should be in the group");
    assert.ok(found.questionIds.includes(second.id), "second question should be in the group");
    assert.equal(found.count, 2, "count should reflect two questions");
  });
});
