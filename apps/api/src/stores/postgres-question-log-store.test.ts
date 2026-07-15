import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { AnswerResult } from "@magpie/core";
import { PostgresQuestionLogStore } from "./postgres-question-log-store.js";
import { gapSummaryKey } from "./question-log-store.js";
import { makeTestPool } from "../test-support/db-pool.js";

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
    gaps: [
      {
        summary: "No source material available",
        question: "test?",
        confidence: "low",
        citedSectionIds: [],
        source: "auto"
      }
    ]
  };
}

function multiGapAnswer(): AnswerResult {
  return {
    answer: "Partial information available.",
    confidence: "low",
    citations: [],
    gaps: [
      { summary: "First gap summary", question: "test?", confidence: "low", citedSectionIds: [], source: "auto" },
      { summary: "Second gap summary", question: "test?", confidence: "low", citedSectionIds: [], source: "auto" }
    ]
  };
}

describe("PostgresQuestionLogStore", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  const store = new PostgresQuestionLogStore(makeTestPool(databaseUrl as string));

  it("round-trips a question through record and get", async () => {
    const uniqueId = randomUUID();
    const recorded = await store.record({
      question: `test-roundtrip-${uniqueId}`,
      chatProvider: "codex",
      retrievedSectionIds: [],
      answer: lowConfidenceAnswer()
    });

    assert.ok(recorded.id);
    assert.equal(recorded.question, `test-roundtrip-${uniqueId}`);
    assert.equal(recorded.chatProvider, "codex");
    assert.equal(recorded.manualGap, false);
    assert.ok((recorded.gaps ?? []).length > 0);

    const fetched = await store.get(recorded.id);
    assert.equal(fetched?.id, recorded.id);
    assert.equal(fetched?.question, recorded.question);
    assert.equal(fetched?.confidence, "low");
  });

  it("a verification re-ask log (#154) keeps its answer but ingests no gaps and is excluded from candidates/list/clustering", async () => {
    const summary = `verification-parity-${randomUUID()}`;
    const gapAnswer: AnswerResult = {
      answer: "still not covered",
      confidence: "low",
      citations: [],
      gaps: [{ summary, question: "test?", confidence: "low", citedSectionIds: [], source: "auto" }]
    };
    const live = await store.record({
      question: `live-${summary}`,
      chatProvider: "codex",
      retrievedSectionIds: [],
      answer: gapAnswer
    });
    const reask = await store.record({
      question: `reask-${summary}`,
      chatProvider: "codex",
      retrievedSectionIds: [],
      purpose: "verification"
    });

    const completed = await store.updateAnswer(reask.id, { answer: gapAnswer });
    assert.equal(completed?.purpose, "verification");
    assert.deepEqual(completed?.gaps ?? [], [], "verification re-ask ingests no gap rows");
    assert.equal(completed?.answer?.answer, "still not covered", "but its answer is recorded");

    const candidates = await store.listGapCandidates(500);
    const candidate = candidates.find((c) => c.summary === summary);
    assert.ok(candidate, "the live question's gap is a candidate");
    assert.deepEqual(candidate?.questionIds, [live.id], "the re-ask log is not in the candidate");

    const gapIds = await store.gapIdsForSummary(summary);
    assert.equal(gapIds.length, 1, "clustering sees only the live gap");

    const listed = await store.list(500);
    assert.ok(!listed.some((log) => log.id === reask.id), "the re-ask log is absent from the questions list");
    assert.ok(
      listed.some((log) => log.id === live.id),
      "the live question is present"
    );
  });

  it("stores auto-detected gaps when recording with an answer", async () => {
    const uniqueId = randomUUID();
    const recorded = await store.record({
      question: `test-gaps-${uniqueId}`,
      chatProvider: "codex",
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
      chatProvider: "codex",
      retrievedSectionIds: []
    });

    const updated = await store.recordFeedback(recorded.id, "unhelpful");
    assert.equal(updated?.feedback, "unhelpful");
    assert.ok(updated?.feedbackAt);
    // Unanswered (unknown confidence) — no feedback gap is raised.
    assert.ok(!(updated?.gaps ?? []).some((gap) => gap.source === "feedback"));

    const fetched = await store.get(recorded.id);
    assert.equal(fetched?.feedback, "unhelpful");
  });

  it("'unhelpful' on a confident answer raises a 'feedback' gap; 'helpful' withdraws it (#241)", async () => {
    const questionText = `test-feedback-gap-${randomUUID()}`;
    const recorded = await store.record({
      question: questionText,
      chatProvider: "codex",
      retrievedSectionIds: [],
      answer: { answer: "Set FOO=1 and restart.", confidence: "high", citations: [], gaps: [] }
    });

    const updated = await store.recordFeedback(recorded.id, "unhelpful");
    assert.ok(
      (updated?.gaps ?? []).some((gap) => gap.summary === questionText && gap.source === "feedback"),
      "a feedback gap is filed under the question text"
    );

    // The gap is a real candidate, keyed on the gap row despite the confident answer.
    const candidates = await store.listGapCandidates(500);
    const candidate = candidates.find((c) => c.summary === questionText);
    assert.deepEqual(candidate?.questionIds, [recorded.id]);

    // A repeated verdict keeps the existing live row (and its gap id) rather
    // than minting a duplicate.
    const repeated = await store.recordFeedback(recorded.id, "unhelpful");
    assert.equal((repeated?.gaps ?? []).filter((gap) => gap.source === "feedback").length, 1);

    // Flipping to 'helpful' withdraws the signal.
    const withdrawn = await store.recordFeedback(recorded.id, "helpful");
    assert.equal(withdrawn?.feedback, "helpful");
    assert.ok(!(withdrawn?.gaps ?? []).some((gap) => gap.source === "feedback"));
    const after = await store.listGapCandidates(500);
    assert.ok(!after.some((c) => c.summary === questionText));
  });

  it("'unhelpful' on a low-confidence answer raises no feedback gap", async () => {
    const recorded = await store.record({
      question: `test-feedback-low-${randomUUID()}`,
      chatProvider: "codex",
      retrievedSectionIds: [],
      answer: lowConfidenceAnswer()
    });

    const updated = await store.recordFeedback(recorded.id, "unhelpful");
    assert.equal(updated?.feedback, "unhelpful");
    assert.ok(!(updated?.gaps ?? []).some((gap) => gap.source === "feedback"));
  });

  it("re-answering preserves a feedback gap (only auto/followup rows are replaced)", async () => {
    const questionText = `test-feedback-survives-${randomUUID()}`;
    const recorded = await store.record({
      question: questionText,
      chatProvider: "codex",
      retrievedSectionIds: [],
      answer: { answer: "Confident answer.", confidence: "high", citations: [], gaps: [] }
    });
    await store.recordFeedback(recorded.id, "unhelpful");

    const updated = await store.updateAnswer(recorded.id, { answer: lowConfidenceAnswer() });

    assert.ok(
      (updated?.gaps ?? []).some((gap) => gap.summary === questionText && gap.source === "feedback"),
      "the feedback gap survives the re-answer"
    );
    assert.ok((updated?.gaps ?? []).some((gap) => gap.source === "auto"));
  });

  it("records a manual gap with a provided summary", async () => {
    const uniqueId = randomUUID();
    const recorded = await store.record({
      question: `test-manual-gap-${uniqueId}`,
      chatProvider: "codex",
      retrievedSectionIds: []
    });

    const updated = await store.recordManualGap(recorded.id, "Manual gap summary for testing");
    assert.equal(updated?.manualGap, true);
    assert.ok(updated?.manualGapAt);
    assert.ok(
      (updated?.gaps ?? []).some((gap) => gap.summary === "Manual gap summary for testing" && gap.source === "manual")
    );
  });

  it("records a manual gap defaulting to the question text when no summary provided", async () => {
    const uniqueId = randomUUID();
    const questionText = `test-manual-default-${uniqueId}`;
    const recorded = await store.record({
      question: questionText,
      chatProvider: "codex",
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
      chatProvider: "codex",
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
      chatProvider: "codex",
      retrievedSectionIds: [],
      answer: lowConfidenceAnswer()
    });

    await store.recordManualGap(recorded.id, "Manual gap to preserve");

    const newAnswer: AnswerResult = {
      answer: "Updated answer.",
      confidence: "high",
      citations: [],
      gaps: [{ summary: "New auto gap", question: "test?", confidence: "low", citedSectionIds: [], source: "auto" }]
    };

    const updated = await store.updateAnswer(recorded.id, {
      answer: newAnswer,
      chatProvider: "codex"
    });

    assert.equal(updated?.confidence, "high");
    assert.ok((updated?.gaps ?? []).some((gap) => gap.summary === "Manual gap to preserve" && gap.source === "manual"));
    assert.ok((updated?.gaps ?? []).some((gap) => gap.summary === "New auto gap" && gap.source === "auto"));
  });

  it("updateAnswer with identical gaps preserves gap ids and does not bump the revision (#168)", async () => {
    const uniqueId = randomUUID();
    const answer = lowConfidenceAnswer();
    const recorded = await store.record({
      question: `test-noop-reanswer-${uniqueId}`,
      chatProvider: "codex",
      retrievedSectionIds: [],
      answer,
      flowId: `flow-${uniqueId}`
    });
    const gapIdsBefore = await store.gapIdsForSummary("No source material available", `flow-${uniqueId}`);
    assert.equal(gapIdsBefore.length, 1, "the recorded auto gap exists");
    const revBefore = await store.getGapCatalogRevision(`flow-${uniqueId}`);

    // Re-answer with the SAME gaps and flow — a no-op for the candidate set.
    await store.updateAnswer(recorded.id, { answer, chatProvider: "openai-compatible", flowId: `flow-${uniqueId}` });

    assert.equal(
      await store.getGapCatalogRevision(`flow-${uniqueId}`),
      revBefore,
      "an identical re-answer does not bump the revision"
    );
    const gapIdsAfter = await store.gapIdsForSummary("No source material available", `flow-${uniqueId}`);
    assert.deepEqual(
      gapIdsAfter,
      gapIdsBefore,
      "the gap row keeps its id (so any cluster membership keyed off it survives)"
    );
    assert.equal((await store.get(recorded.id))?.chatProvider, "openai-compatible", "the answer itself still updated");
  });

  it("updateAnswer with changed gaps replaces them and bumps the revision (#168)", async () => {
    const uniqueId = randomUUID();
    const recorded = await store.record({
      question: `test-changed-reanswer-${uniqueId}`,
      chatProvider: "codex",
      retrievedSectionIds: [],
      answer: lowConfidenceAnswer(),
      flowId: `flow-${uniqueId}`
    });
    const revBefore = await store.getGapCatalogRevision(`flow-${uniqueId}`);

    await store.updateAnswer(recorded.id, { answer: multiGapAnswer(), flowId: `flow-${uniqueId}` });

    assert.ok(
      (await store.getGapCatalogRevision(`flow-${uniqueId}`)) > revBefore,
      "a changed gap set bumps the revision"
    );
    const summaries = ((await store.get(recorded.id))?.gaps ?? []).map((gap) => gap.summary).sort();
    assert.deepEqual(summaries, ["First gap summary", "Second gap summary"], "the gaps were replaced");
  });

  it("persists a followup-sourced gap from a confident answer", async () => {
    const uniqueId = randomUUID();
    const answer: AnswerResult = {
      answer: "Deploy with the script.",
      confidence: "high",
      citations: [],
      gaps: [
        {
          summary: `missing deploy example ${uniqueId}`,
          question: "how do I deploy?",
          confidence: "high",
          citedSectionIds: [],
          source: "followup"
        }
      ]
    };

    const recorded = await store.record({
      question: `test-followup-${uniqueId}`,
      chatProvider: "codex",
      retrievedSectionIds: [],
      answer
    });

    const reloaded = await store.get(recorded.id);
    assert.equal(reloaded?.confidence, "high", "a followup gap does not force the answer low");
    assert.ok(
      (reloaded?.gaps ?? []).some(
        (gap) => gap.summary === `missing deploy example ${uniqueId}` && gap.source === "followup"
      ),
      "the followup gap is persisted with its source"
    );
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
      chatProvider: "codex",
      retrievedSectionIds: []
    });

    const second = await store.record({
      question: `test-list-2-${uniqueId}`,
      chatProvider: "codex",
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

  it("pages the question list with an offset and reports a live-question count", async () => {
    const uniqueId = randomUUID();
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const recorded = await store.record({
        question: `test-page-${index}-${uniqueId}`,
        chatProvider: "codex",
        retrievedSectionIds: []
      });
      ids.push(recorded.id);
    }

    // Race-safe against parallel suites inserting their own rows: assert lower
    // bounds and page sizes rather than exact table contents.
    assert.ok((await store.count()) >= 3, "count covers at least the rows this test created");
    assert.equal((await store.list(2, 0)).length, 2, "limit bounds the page");
    const all = await store.list(200);
    assert.ok(
      ids.every((id) => all.some((log) => log.id === id)),
      "an offset-0 walk reaches the created rows"
    );
    assert.deepEqual(await store.list(200, 1_000_000), [], "an offset past the end returns an empty page");
  });

  it("searches the question text case-insensitively, matching LIKE wildcards literally", async () => {
    // The unique token keeps this race-safe against parallel suites: only this
    // test's rows can match it.
    const token = `srch-${randomUUID()}`;
    const matching = await store.record({
      question: `How do I DEPLOY ${token}?`,
      chatProvider: "codex",
      retrievedSectionIds: []
    });
    await store.record({
      question: `Unrelated widget question ${token}-other`,
      chatProvider: "codex",
      retrievedSectionIds: []
    });

    assert.equal(await store.count(`deploy ${token}`), 1);
    const found = await store.list(50, 0, `deploy ${token}`);
    assert.deepEqual(
      found.map((log) => log.id),
      [matching.id]
    );
    assert.deepEqual(
      await store.list(50, 0, `deploy_${token}`),
      [],
      "an underscore in the term is literal, not a LIKE wildcard"
    );
    assert.deepEqual(await store.list(50, 0, `%${token}%`), [], "percent signs are literal too");
  });

  it("resolves gaps by question id and summary", async () => {
    const uniqueId = randomUUID();
    const recorded = await store.record({
      question: `test-resolve-${uniqueId}`,
      chatProvider: "codex",
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

  it("records a verification gap with a note and surfaces it as a candidate", async () => {
    const uniqueId = randomUUID();
    const recorded = await store.record({
      question: `test-verify-${uniqueId}`,
      chatProvider: "codex",
      retrievedSectionIds: []
    });

    const summary = `still weak ${uniqueId}`;
    const updated = await store.recordVerificationGap(recorded.id, {
      summary,
      note: "merged docs/guide.md; re-ask still low; missing concrete example",
      parked: false
    });
    const vGap = (updated?.gaps ?? []).find((gap) => gap.summary === summary);
    assert.equal(vGap?.source, "verification");
    assert.equal(vGap?.note, "merged docs/guide.md; re-ask still low; missing concrete example");

    // A verification gap is unresolved, so it re-clusters as a candidate.
    const candidates = await store.listGapCandidates(1000);
    assert.ok(
      candidates.some((candidate) => candidate.summary === summary),
      "verification gap surfaces as a candidate"
    );
  });

  it("a parked gap (#158) is retained with parkedAt but excludes its whole question from candidates", async () => {
    const uniqueId = randomUUID();
    const recorded = await store.record({
      question: `test-parked-${uniqueId}`,
      chatProvider: "codex",
      retrievedSectionIds: []
    });

    const summary = `capped ${uniqueId}`;
    await store.recordVerificationGap(recorded.id, {
      summary,
      note: "two failed verifications; awaiting a human",
      parked: true
    });

    const fetched = await store.get(recorded.id);
    const parkedGaps = (fetched?.gaps ?? []).filter((gap) => gap.summary === summary);
    assert.equal(parkedGaps.length, 1, "parked in place, a single row");
    assert.equal(parkedGaps[0]?.source, "verification", "parking is a state, not a source change");
    assert.ok(parkedGaps[0]?.parkedAt, "parkedAt is stamped");

    const candidates = await store.listGapCandidates(1000);
    assert.ok(!candidates.some((candidate) => candidate.summary === summary), "a parked gap does not auto-redraft");
    // Clustering also excludes the parked question.
    assert.equal((await store.gapIdsForSummary(summary)).length, 0, "excluded from clustering");
  });

  // Regression tests for issue #151: recordVerificationGap used to
  // unconditionally DELETE any prior verification row before inserting the
  // reopened one, destroying resolved/dismissed audit history and reassigning a
  // fresh row id (orphaning any cluster membership keyed off the old id). It must
  // instead update the live row in place — preserving its id — and leave
  // resolved/dismissed rows untouched, inserting a fresh row only when no live
  // row exists.

  it("recordVerificationGap updates the live gap in place, preserving its id, on a repeat reopen", async () => {
    const uniqueId = randomUUID();
    const recorded = await store.record({
      question: `test-verify-inplace-${uniqueId}`,
      chatProvider: "codex",
      retrievedSectionIds: []
    });

    const summary = `still weak ${uniqueId}`;
    await store.recordVerificationGap(recorded.id, {
      summary,
      note: "first failure",
      parked: false
    });
    const idsBefore = await store.gapIdsForSummary(summary);
    assert.equal(idsBefore.length, 1);

    // A second failure on the same still-open lineage (before the cap) keeps the
    // same summary, so the gap row's id must be preserved rather than replaced.
    const updated = await store.recordVerificationGap(recorded.id, {
      summary,
      note: "second failure",
      parked: false
    });

    const idsAfter = await store.gapIdsForSummary(summary);
    assert.deepEqual(idsAfter, idsBefore, "the gap row keeps the same id across the in-place update");
    const gaps = (updated?.gaps ?? []).filter((gap) => gap.summary === summary);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]?.source, "verification");
    assert.equal(gaps[0]?.note, "second failure");
  });

  it("recordVerificationGap retains a resolved gap and inserts a fresh row for a later failure", async () => {
    const uniqueId = randomUUID();
    const recorded = await store.record({
      question: `test-verify-resolved-${uniqueId}`,
      chatProvider: "codex",
      retrievedSectionIds: []
    });

    const firstSummary = `first gap ${uniqueId}`;
    const secondSummary = `second gap ${uniqueId}`;
    await store.recordVerificationGap(recorded.id, {
      summary: firstSummary,
      note: "first failure",
      parked: false
    });
    const resolved = await store.resolveGaps([recorded.id], [firstSummary], randomUUID());
    assert.equal(resolved, 1);

    // A brand-new proposal later fails verification on the same question.
    const updated = await store.recordVerificationGap(recorded.id, {
      summary: secondSummary,
      note: "second failure",
      parked: false
    });

    assert.equal((updated?.gaps ?? []).length, 2, "the resolved gap is retained alongside the fresh one");
    const oldGap = updated?.gaps?.find((gap) => gap.summary === firstSummary);
    assert.ok(oldGap?.resolvedAt, "the resolved gap keeps its resolution");
    const freshGap = updated?.gaps?.find((gap) => gap.summary === secondSummary);
    assert.equal(freshGap?.resolvedAt, undefined);
    assert.equal(freshGap?.source, "verification");
  });

  it("recordVerificationGap retains a dismissed gap and inserts a fresh row for a later failure", async () => {
    const uniqueId = randomUUID();
    const recorded = await store.record({
      question: `test-verify-dismissed-${uniqueId}`,
      chatProvider: "codex",
      retrievedSectionIds: []
    });

    const summary = `flaky gap ${uniqueId}`;
    await store.recordVerificationGap(recorded.id, {
      summary,
      note: "first failure",
      parked: false
    });
    const gapIds = await store.gapIdsForSummary(summary);
    const dismissed = await store.dismissGaps(gapIds, "unrelated to the knowledge base");
    assert.equal(dismissed, 1);

    // A new failure raised on the same question must not resurrect the
    // dismissed row.
    const updated = await store.recordVerificationGap(recorded.id, {
      summary,
      note: "second failure",
      parked: false
    });

    assert.equal((updated?.gaps ?? []).length, 2, "the dismissed gap is retained alongside the fresh one");
    const dismissedGaps = (updated?.gaps ?? []).filter((gap) => gap.dismissedAt);
    assert.equal(dismissedGaps.length, 1, "exactly one dismissed gap remains, untouched");
    assert.equal(dismissedGaps[0]?.dismissedReason, "unrelated to the knowledge base");
    const liveGaps = (updated?.gaps ?? []).filter((gap) => !gap.resolvedAt && !gap.dismissedAt);
    assert.equal(liveGaps.length, 1, "exactly one fresh live gap was inserted");
  });

  it("retryParkedGap re-files a live verification row when the parked gap is the only one, and lists/unlists via listParkedQuestions", async () => {
    const summary = `parked-retry-${randomUUID()}`;
    const recorded = await store.record({ question: `q-${summary}`, chatProvider: "codex", retrievedSectionIds: [] });
    await store.recordVerificationGap(recorded.id, { summary, note: "awaiting a human", parked: true });

    const parkedList = await store.listParkedQuestions(1000);
    const entry = parkedList.find((p) => p.questionId === recorded.id);
    assert.ok(entry, "the parked question is listed");
    assert.equal(entry?.summary, summary);
    assert.equal(entry?.note, "awaiting a human");
    assert.ok(entry?.parkedAt);
    assert.equal((await store.gapIdsForSummary(summary)).length, 0, "parked → excluded from clustering");

    const retried = await store.retryParkedGap(recorded.id);
    const gaps = retried?.gaps ?? [];
    assert.ok(
      gaps.some((g) => g.dismissedAt && g.dismissedReason === "human_retry"),
      "parked row dismissed as boundary"
    );
    const live = gaps.filter((g) => !g.resolvedAt && !g.dismissedAt);
    assert.equal(live.length, 1, "a fresh live verification row was re-filed");
    assert.equal(live[0]?.source, "verification");
    assert.equal(live[0]?.note, "awaiting a human");
    assert.ok(!live[0]?.parkedAt, "the re-filed row is not parked");
    assert.ok(!(await store.listParkedQuestions(1000)).some((p) => p.questionId === recorded.id), "no longer parked");
    assert.equal((await store.gapIdsForSummary(summary)).length, 1, "re-admitted to clustering");
  });

  it("retryParkedGap preserves the note (re-files a live verification row) alongside the surviving auto gap, deduped to one candidate", async () => {
    const summary = `parked-sibling-${randomUUID()}`;
    const answer: AnswerResult = {
      answer: "weak",
      confidence: "low",
      citations: [],
      gaps: [{ summary, question: "q?", confidence: "low", citedSectionIds: [], source: "auto" }]
    };
    const recorded = await store.record({
      question: `q-${summary}`,
      chatProvider: "codex",
      retrievedSectionIds: [],
      answer
    });
    await store.recordVerificationGap(recorded.id, { summary, note: "cap hit", parked: true });

    const retried = await store.retryParkedGap(recorded.id);
    const live = (retried?.gaps ?? []).filter((g) => g.summary === summary && !g.resolvedAt && !g.dismissedAt);
    const verification = live.find((g) => g.source === "verification");
    assert.ok(verification, "a live verification row carries the note forward (#158 review #1)");
    assert.equal(verification?.note, "cap hit");
    assert.ok(
      live.some((g) => g.source === "auto"),
      "the surviving auto gap is untouched"
    );
    const candidates = await store.listGapCandidates(1000);
    assert.equal(candidates.filter((c) => c.summary === summary).length, 1, "deduped to a single candidate");
  });

  it("dismissParkedGap abandons only the parked topic, leaving an unrelated gap on the same question (#158 review #2)", async () => {
    const parkedSummary = `parked-topic-${randomUUID()}`;
    const otherSummary = `other-topic-${randomUUID()}`;
    const answer: AnswerResult = {
      answer: "weak",
      confidence: "low",
      citations: [],
      gaps: [{ summary: otherSummary, question: "q?", confidence: "low", citedSectionIds: [], source: "auto" }]
    };
    const recorded = await store.record({
      question: `q-multi-${parkedSummary}`,
      chatProvider: "codex",
      retrievedSectionIds: [],
      answer
    });
    await store.recordVerificationGap(recorded.id, { summary: parkedSummary, note: "cap hit", parked: true });

    const dismissed = await store.dismissParkedGap(recorded.id);
    const parkedLive = (dismissed?.gaps ?? []).some(
      (g) => g.summary === parkedSummary && !g.resolvedAt && !g.dismissedAt
    );
    assert.equal(parkedLive, false, "the parked topic is dismissed");
    const other = (dismissed?.gaps ?? []).find((g) => g.summary === otherSummary);
    assert.ok(other && !other.dismissedAt && !other.resolvedAt, "the unrelated topic survives");
    assert.equal((await store.gapIdsForSummary(parkedSummary)).length, 0, "parked topic never re-clusters");
    assert.equal((await store.gapIdsForSummary(otherSummary)).length, 1, "unrelated topic re-enters candidacy");
    assert.ok(!(await store.listParkedQuestions(1000)).some((p) => p.questionId === recorded.id), "no longer parked");
  });

  it("retryParkedGap / dismissParkedGap are no-ops on a question that is not parked", async () => {
    const recorded = await store.record({
      question: `not-parked-${randomUUID()}`,
      chatProvider: "codex",
      retrievedSectionIds: []
    });
    const afterRetry = await store.retryParkedGap(recorded.id);
    assert.deepEqual(afterRetry?.gaps ?? [], [], "retry no-op");
    const afterDismiss = await store.dismissParkedGap(recorded.id);
    assert.deepEqual(afterDismiss?.gaps ?? [], [], "dismiss no-op");
  });

  it("listGapCandidates includes low-confidence auto-detected gaps", async () => {
    const uniqueId = randomUUID();
    await store.record({
      question: `test-candidate-${uniqueId}`,
      chatProvider: "codex",
      retrievedSectionIds: [],
      answer: lowConfidenceAnswer()
    });

    const candidates = await store.listGapCandidates(200);
    const found = candidates.some((candidate) => candidate.summary === "No source material available");

    assert.ok(found, "low-confidence gap should appear in candidates");
  });

  it("listGapCandidates includes a followup gap raised on a confident answer", async () => {
    // A confident, well-cited answer whose search for supporting material (e.g.
    // SOC 2 docs) verifiably found nothing: the followup gap must still become
    // a candidate — candidacy keys on gap rows, not question confidence.
    const uniqueId = randomUUID();
    const followupSummary = `SOC 2 compliance status ${uniqueId}`;
    await store.record({
      question: `test-followup-candidate-${uniqueId}`,
      chatProvider: "codex",
      retrievedSectionIds: [],
      answer: {
        answer: "Deploy with the script.",
        confidence: "high",
        citations: [],
        gaps: [
          { summary: followupSummary, question: "secure?", confidence: "high", citedSectionIds: [], source: "followup" }
        ]
      }
    });

    const candidates = await store.listGapCandidates(200);
    const found = candidates.some((candidate) => candidate.summary === followupSummary);

    assert.ok(found, "followup gap on a confident answer should appear in candidates");
  });

  it("listGapCandidates includes manually flagged questions regardless of confidence", async () => {
    const uniqueId = randomUUID();
    const recorded = await store.record({
      question: `test-manual-candidate-${uniqueId}`,
      chatProvider: "codex",
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
      chatProvider: "codex",
      retrievedSectionIds: [],
      answer: {
        answer: "Answer.",
        confidence: "low",
        citations: [],
        gaps: [{ summary: sharedGap, question: "test?", confidence: "low", citedSectionIds: [], source: "auto" }]
      }
    });

    const second = await store.record({
      question: `test-shared-2-${uniqueId}`,
      chatProvider: "codex",
      retrievedSectionIds: [],
      answer: {
        answer: "Answer.",
        confidence: "low",
        citations: [],
        gaps: [{ summary: sharedGap, question: "test?", confidence: "low", citedSectionIds: [], source: "auto" }]
      }
    });

    const candidates = await store.listGapCandidates(200);
    const found = candidates.find((candidate) => candidate.summary === sharedGap);

    assert.ok(found, "shared gap should appear in candidates");
    assert.ok(found.questionIds.includes(first.id), "first question should be in the group");
    assert.ok(found.questionIds.includes(second.id), "second question should be in the group");
    assert.equal(found.count, 2, "count should reflect two questions");
  });

  it("gapIdsForSummaries batches pairs and matches gapIdsForSummary per pair", async () => {
    const uniqueId = randomUUID();
    const summaryX = `batch gap X ${uniqueId}`;
    const summaryY = `batch gap Y ${uniqueId}`;
    const lowGap = (summary: string): AnswerResult => ({
      answer: "Answer.",
      confidence: "low",
      citations: [],
      gaps: [{ summary, question: "test?", confidence: "low", citedSectionIds: [], source: "auto" }]
    });

    await store.record({
      question: `bx1-${uniqueId}`,
      chatProvider: "codex",
      retrievedSectionIds: [],
      answer: lowGap(summaryX)
    });
    await store.record({
      question: `bx2-${uniqueId}`,
      chatProvider: "codex",
      retrievedSectionIds: [],
      answer: lowGap(summaryX)
    });
    await store.record({
      question: `by1-${uniqueId}`,
      chatProvider: "codex",
      retrievedSectionIds: [],
      answer: lowGap(summaryY),
      flowId: `flow-${uniqueId}`
    });

    const batched = await store.gapIdsForSummaries([
      { summary: summaryX },
      { summary: summaryY, flowId: `flow-${uniqueId}` },
      { summary: summaryX, flowId: `flow-${uniqueId}` }
    ]);

    // Each pair matches the single-summary variant exactly.
    assert.deepEqual(batched.get(gapSummaryKey(summaryX))?.sort(), (await store.gapIdsForSummary(summaryX)).sort());
    assert.deepEqual(
      batched.get(gapSummaryKey(summaryY, `flow-${uniqueId}`)),
      await store.gapIdsForSummary(summaryY, `flow-${uniqueId}`)
    );
    // A pair with no matching gaps is present with an empty array.
    assert.deepEqual(batched.get(gapSummaryKey(summaryX, `flow-${uniqueId}`)), []);
  });
});
