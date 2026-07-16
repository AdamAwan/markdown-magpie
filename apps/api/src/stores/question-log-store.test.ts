import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnswerResult } from "@magpie/core";
import { InMemoryQuestionLogStore, gapSummaryKey } from "./question-log-store.js";

const lowGapAnswer: AnswerResult = {
  answer: "I could not find reliable source material.",
  confidence: "low",
  citations: [],
  gaps: [
    {
      summary: "No source material for: vaccines",
      question: "vaccines?",
      confidence: "low",
      citedSectionIds: [],
      source: "auto"
    }
  ]
};

const multiGapAnswer: AnswerResult = {
  answer: "The context covers setup but not React integration or dashboard export.",
  confidence: "low",
  citations: [],
  gaps: [
    {
      summary: "No React integration guidance",
      question: "react + export?",
      confidence: "low",
      citedSectionIds: [],
      source: "auto"
    },
    {
      summary: "Dashboard export is undocumented",
      question: "react + export?",
      confidence: "low",
      citedSectionIds: [],
      source: "auto"
    }
  ]
};

test("delete removes the question, bumps the catalog when it had gaps, and reports existence", async () => {
  const store = new InMemoryQuestionLogStore();
  const withGaps = await store.record({
    question: "vaccines?",
    chatProvider: "codex",
    retrievedSectionIds: [],
    answer: lowGapAnswer
  });
  const before = await store.getGapCatalogRevision();

  assert.equal(await store.delete(withGaps.id), true);
  assert.equal(await store.get(withGaps.id), undefined, "the question is gone");
  assert.equal(await store.getGapCatalogRevision(), before + 1, "removing a gap bumps the candidate catalog");

  assert.equal(await store.delete("nope"), false, "a missing question reports false");
});

test("delete of a gap-less question does not bump the catalog", async () => {
  const store = new InMemoryQuestionLogStore();
  const plain = await store.record({ question: "hello?", chatProvider: "codex", retrievedSectionIds: [] });
  const before = await store.getGapCatalogRevision();

  assert.equal(await store.delete(plain.id), true);
  assert.equal(await store.getGapCatalogRevision(), before, "no gaps → no candidate change");
});

test("gapIdsForQuestion returns one distinct id per gap summary, matching gapIdsForSummary", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({
    question: "react + export?",
    chatProvider: "codex",
    retrievedSectionIds: [],
    answer: multiGapAnswer
  });

  const ids = await store.gapIdsForQuestion(log.id);
  assert.equal(ids.length, 2, "one id per distinct gap summary");
  const [bySummary] = await store.gapIdsForSummary("No React integration guidance");
  assert.ok(ids.includes(bySummary), "ids line up with the cluster-membership id format");
  assert.deepEqual(await store.gapIdsForQuestion("nope"), [], "unknown question → no ids");
});

test("list pages with an offset and count matches list's live-question filter", async () => {
  const store = new InMemoryQuestionLogStore();
  for (let index = 0; index < 5; index += 1) {
    await store.record({ question: `Question ${index}?`, chatProvider: "codex", retrievedSectionIds: [] });
  }
  // A verification re-ask is excluded from list(), so it must not count either —
  // otherwise the pager would advertise a page that comes back empty.
  await store.record({
    question: "re-ask",
    chatProvider: "codex",
    retrievedSectionIds: [],
    purpose: "verification"
  });

  assert.equal(await store.count(), 5);
  assert.equal((await store.list(2)).length, 2, "offset defaults to 0");
  assert.equal((await store.list(2, 2)).length, 2);
  assert.equal((await store.list(2, 4)).length, 1, "the final partial page is returned");
  assert.deepEqual(await store.list(2, 5), [], "an offset past the end returns an empty page");
});

test("list and count narrow to a case-insensitive substring of the question text", async () => {
  const store = new InMemoryQuestionLogStore();
  await store.record({ question: "How do I deploy the API?", chatProvider: "codex", retrievedSectionIds: [] });
  await store.record({ question: "Deployment rollback steps?", chatProvider: "codex", retrievedSectionIds: [] });
  await store.record({ question: "What is a widget?", chatProvider: "codex", retrievedSectionIds: [] });
  // Matching text on a verification re-ask stays excluded, like the base filter.
  await store.record({
    question: "deploy re-ask",
    chatProvider: "codex",
    retrievedSectionIds: [],
    purpose: "verification"
  });

  assert.equal(await store.count("DEPLOY"), 2);
  const matches = await store.list(50, 0, "DEPLOY");
  assert.equal(matches.length, 2);
  assert.ok(matches.every((log) => log.question.toLowerCase().includes("deploy")));
  assert.equal((await store.list(1, 1, "deploy")).length, 1, "offset pages within the matches");
  assert.deepEqual(await store.list(50, 0, "no such question"), []);
  assert.equal(await store.count("   "), 3, "a blank search means no filter");
});

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

test("a verification re-ask log (#154) keeps its answer but ingests no gaps and never becomes a candidate", async () => {
  const store = new InMemoryQuestionLogStore();
  // A live question with the same gap, so there IS a real candidate to compare against.
  const live = await store.record({
    question: "vaccines?",
    chatProvider: "codex",
    answer: lowGapAnswer,
    retrievedSectionIds: []
  });
  // The synthetic re-ask log: recorded with no answer, purpose 'verification'.
  const reask = await store.record({
    question: "vaccines?",
    chatProvider: "codex",
    retrievedSectionIds: [],
    purpose: "verification"
  });

  // Completion feeds it exactly the answer a still_open verdict produces — a forced
  // low-confidence answer WITH gap signals. Those must not be ingested.
  const completed = await store.updateAnswer(reask.id, { answer: lowGapAnswer });

  assert.equal(completed?.purpose, "verification");
  assert.deepEqual(completed?.gaps, [], "verification re-ask ingests no gap rows");
  assert.equal(completed?.answer?.answer, lowGapAnswer.answer, "but its answer is still recorded");

  const candidates = await store.listGapCandidates(50);
  assert.equal(candidates.length, 1, "only the live question's gap is a candidate");
  assert.deepEqual(candidates[0]?.questionIds, [live.id], "the re-ask log is not in the candidate");

  const gapIds = await store.gapIdsForSummary(lowGapAnswer.gaps![0]!.summary);
  assert.equal(gapIds.length, 1, "clustering sees only the live gap, not the re-ask");

  const listed = await store.list(50);
  assert.ok(!listed.some((log) => log.id === reask.id), "the re-ask log is absent from the questions list");
  assert.ok(
    listed.some((log) => log.id === live.id),
    "the live question is present"
  );
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
  const log = await store.record({
    question: "Partial answer?",
    chatProvider: "codex",
    answer: helpful,
    retrievedSectionIds: []
  });
  await store.recordManualGap(log.id, "Needs a full guide");

  const candidates = await store.listGapCandidates(50);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].summary, "Needs a full guide");
  assert.deepEqual(candidates[0].questionIds, [log.id]);
});

test("listGapCandidates includes a followup gap raised on a confident answer", async () => {
  // The "do we have SOC 2?" scenario: the answer itself is confident and well
  // cited, but a search for supporting material verifiably found nothing. That
  // followup gap must still cluster — candidacy keys on gap rows, not on the
  // question's confidence.
  const store = new InMemoryQuestionLogStore();
  const confident: AnswerResult = {
    answer: "Deploy with the script.",
    confidence: "high",
    citations: [],
    gaps: [
      {
        summary: "SOC 2 compliance status",
        question: "How do I sell this as secure?",
        confidence: "high",
        citedSectionIds: [],
        source: "followup"
      }
    ]
  };
  const log = await store.record({
    question: "How do I sell this as secure?",
    chatProvider: "codex",
    answer: confident,
    retrievedSectionIds: []
  });

  const candidates = await store.listGapCandidates(50);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].summary, "SOC 2 compliance status");
  assert.deepEqual(candidates[0].questionIds, [log.id]);
});

test("listGapCandidates still includes auto-detected low-confidence gaps", async () => {
  const store = new InMemoryQuestionLogStore();
  await store.record({ question: "vaccines?", chatProvider: "codex", answer: lowGapAnswer, retrievedSectionIds: [] });

  const candidates = await store.listGapCandidates(50);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].summary, "No source material for: vaccines");
});

test("drops the no-source-material fallback gap so it never becomes a candidate", async () => {
  const store = new InMemoryQuestionLogStore();
  // A whole-question miss where the model named no specific gap: the watcher emits
  // the synthesised fallback that echoes the question verbatim. It must not seed a
  // gap candidate (and so never a singleton cluster/proposal) — the fan-out source.
  await store.record({
    question: "What TLS versions does NXG use in transit?",
    chatProvider: "codex",
    answer: {
      answer: "I could not find reliable source material for this question.",
      confidence: "low",
      citations: [],
      gaps: [
        {
          summary: "No sufficient source material found for: What TLS versions does NXG use in transit?",
          question: "What TLS versions does NXG use in transit?",
          confidence: "low",
          citedSectionIds: [],
          source: "auto"
        }
      ]
    },
    retrievedSectionIds: []
  });

  assert.deepEqual(await store.listGapCandidates(50), [], "the echoed fallback never enters gap candidacy");
});

test("keeps a model-articulated gap alongside a dropped fallback on the same answer", async () => {
  const store = new InMemoryQuestionLogStore();
  await store.record({
    question: "How does NXG encrypt data and where are keys stored?",
    chatProvider: "codex",
    answer: {
      answer: "Partial.",
      confidence: "low",
      citations: [],
      gaps: [
        {
          summary: "No sufficient source material found for: key storage",
          question: "keys?",
          confidence: "low",
          citedSectionIds: [],
          source: "auto"
        },
        {
          summary: "Encryption key storage location is undocumented",
          question: "keys?",
          confidence: "low",
          citedSectionIds: [],
          source: "auto"
        }
      ]
    },
    retrievedSectionIds: []
  });

  const candidates = await store.listGapCandidates(50);
  assert.deepEqual(
    candidates.map((c) => c.summary),
    ["Encryption key storage location is undocumented"],
    "only the real, articulated gap survives; the fallback is dropped"
  );
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
      gaps: [
        {
          summary: "Dashboard export is undocumented",
          question: "export?",
          confidence: "low",
          citedSectionIds: [],
          source: "auto"
        }
      ]
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
    gaps: [
      { summary: "Pricing is undocumented", question: "price?", confidence: "low", citedSectionIds: [], source: "auto" }
    ]
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
  const log = await store.record({
    question: "Partial answer?",
    chatProvider: "codex",
    answer: helpful,
    retrievedSectionIds: []
  });
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
  assert.deepEqual(result.get(gapSummaryKey("X"))?.sort(), (await store.gapIdsForSummary("X")).sort());
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

// Regression tests for issue #151: recordVerificationGap used to unconditionally
// replace any prior verification gap, destroying resolved and dismissed rows (and
// their audit trail) and reassigning a fresh identity to the reopened gap. It must
// now update the live row in place (preserving its identity) and leave
// resolved/dismissed rows untouched, inserting a fresh row only when no live row
// exists. Parking (retry cap hit) is the `parked` flag (issue #158), not a source.

test("recordVerificationGap inserts a fresh gap when none has been raised yet", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({ question: "How do I configure X?", chatProvider: "codex", retrievedSectionIds: [] });

  const updated = await store.recordVerificationGap(log.id, {
    summary: "How to configure X",
    note: "merged docs/x.md; re-ask still low",
    parked: false
  });

  assert.deepEqual(updated?.gaps, [
    { summary: "How to configure X", source: "verification", note: "merged docs/x.md; re-ask still low" }
  ]);
});

test("recordVerificationGap updates the live gap in place, preserving its id, on a repeat reopen", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({ question: "How do I configure X?", chatProvider: "codex", retrievedSectionIds: [] });

  await store.recordVerificationGap(log.id, {
    summary: "How to configure X",
    note: "first failure",
    parked: false
  });
  const idsBefore = await store.gapIdsForSummary("How to configure X");
  assert.equal(idsBefore.length, 1);

  // A second failure on the same still-open lineage (before the cap) keeps the
  // same summary, so the gap's identity must be preserved rather than replaced.
  const updated = await store.recordVerificationGap(log.id, {
    summary: "How to configure X",
    note: "second failure",
    parked: false
  });

  const idsAfter = await store.gapIdsForSummary("How to configure X");
  assert.deepEqual(idsAfter, idsBefore, "the gap keeps the same id across the in-place update");
  assert.equal(updated?.gaps?.length, 1, "updated in place, not appended");
  assert.deepEqual(updated?.gaps, [{ summary: "How to configure X", source: "verification", note: "second failure" }]);
});

test("recordVerificationGap parks the whole question in place when the retry cap is hit", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({ question: "How do I configure X?", chatProvider: "codex", retrievedSectionIds: [] });

  await store.recordVerificationGap(log.id, { summary: "How to configure X", note: "first failure", parked: false });
  assert.equal((await store.gapIdsForSummary("How to configure X")).length, 1, "a candidate before the cap");

  const parked = await store.recordVerificationGap(log.id, {
    summary: "How to configure X",
    note: "retry cap hit",
    parked: true
  });

  const gap = parked?.gaps?.[0];
  assert.equal(parked?.gaps?.length, 1, "parked in place, not appended");
  assert.equal(gap?.source, "verification", "parking is a state, not a source change");
  assert.ok(gap?.parkedAt, "parkedAt is stamped");
  assert.equal(
    (await store.gapIdsForSummary("How to configure X")).length,
    0,
    "a parked question is excluded from clustering"
  );
  assert.equal((await store.listGapCandidates(50)).length, 0, "and from candidacy");
});

test("recordVerificationGap retains a resolved gap and inserts a fresh row for a later failure", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({ question: "How do I configure X?", chatProvider: "codex", retrievedSectionIds: [] });

  await store.recordVerificationGap(log.id, {
    summary: "How to configure X",
    note: "first failure",
    parked: false
  });
  const resolved = await store.resolveGaps([log.id], ["How to configure X"], "proposal-1");
  assert.equal(resolved, 1);

  // A brand-new proposal later fails verification on the same question.
  const updated = await store.recordVerificationGap(log.id, {
    summary: "How to configure X, part 2",
    note: "second failure",
    parked: false
  });

  assert.equal(updated?.gaps?.length, 2, "the resolved gap is retained alongside the fresh one");
  const oldGap = updated?.gaps?.find((gap) => gap.summary === "How to configure X");
  assert.ok(oldGap?.resolvedAt, "the resolved gap keeps its resolution");
  assert.equal(oldGap?.resolvedByProposalId, "proposal-1");
  const freshGap = updated?.gaps?.find((gap) => gap.summary === "How to configure X, part 2");
  assert.equal(freshGap?.resolvedAt, undefined);
  assert.equal(freshGap?.source, "verification");
});

test("recordVerificationGap retains a dismissed gap and inserts a fresh row for a later failure", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({ question: "How do I configure X?", chatProvider: "codex", retrievedSectionIds: [] });

  await store.recordVerificationGap(log.id, {
    summary: "How to configure X",
    note: "first failure",
    parked: false
  });
  const gapIds = await store.gapIdsForSummary("How to configure X");
  const dismissed = await store.dismissGaps(gapIds, "unrelated to the knowledge base");
  assert.equal(dismissed, 1);

  // A new failure on the same question must not resurrect the dismissed gap.
  const updated = await store.recordVerificationGap(log.id, {
    summary: "How to configure X",
    note: "second failure",
    parked: false
  });

  assert.equal(updated?.gaps?.length, 2, "the dismissed gap is retained alongside the fresh one");
  const dismissedGaps = (updated?.gaps ?? []).filter((gap) => gap.dismissedAt);
  assert.equal(dismissedGaps.length, 1, "exactly one dismissed gap remains, untouched");
  assert.equal(dismissedGaps[0]?.dismissedReason, "unrelated to the knowledge base");
  const liveGaps = (updated?.gaps ?? []).filter((gap) => !gap.resolvedAt && !gap.dismissedAt);
  assert.equal(liveGaps.length, 1, "exactly one fresh live gap was inserted");
});

// Parked-gap human workflow (issue #158): retry / dismiss / listing.

test("retryParkedGap re-admits a parked question, re-filing a live gap when the underlying one is gone", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({ question: "How do I configure X?", chatProvider: "codex", retrievedSectionIds: [] });
  // Park it: a verification gap that hit the retry cap. It is the question's only gap.
  await store.recordVerificationGap(log.id, { summary: "How to configure X", note: "retry cap hit", parked: true });
  assert.equal((await store.listGapCandidates(50)).length, 0, "parked → excluded from candidacy");

  const retried = await store.retryParkedGap(log.id);

  const parkedNow = (retried?.gaps ?? []).filter((gap) => gap.parkedAt && !gap.dismissedAt);
  assert.equal(parkedNow.length, 0, "no live parked row remains");
  const dismissed = (retried?.gaps ?? []).find((gap) => gap.dismissedAt);
  assert.equal(dismissed?.dismissedReason, "human_retry", "the parked row is dismissed as the lineage boundary");
  const live = (retried?.gaps ?? []).filter((gap) => !gap.resolvedAt && !gap.dismissedAt);
  assert.equal(live.length, 1, "a fresh live verification row was re-filed");
  assert.equal(live[0]?.source, "verification");
  assert.equal(live[0]?.note, "retry cap hit", "the note is carried into the re-draft");
  const candidates = await store.listGapCandidates(50);
  assert.ok(
    candidates.some((c) => c.summary === "How to configure X"),
    "re-admitted to candidacy"
  );
});

test("retryParkedGap preserves the note (re-files a live verification row) even when the auto gap survives, without forking a duplicate candidate", async () => {
  const store = new InMemoryQuestionLogStore();
  // A live auto gap AND a parked verification gap share the summary (the common case).
  const log = await store.record({
    question: "vaccines?",
    chatProvider: "codex",
    answer: lowGapAnswer,
    retrievedSectionIds: []
  });
  const summary = lowGapAnswer.gaps![0]!.summary;
  await store.recordVerificationGap(log.id, { summary, note: "retry cap hit", parked: true });

  const retried = await store.retryParkedGap(log.id);

  const live = (retried?.gaps ?? []).filter((gap) => !gap.resolvedAt && !gap.dismissedAt);
  // auto(summary) + a re-filed verification(summary) carrying the note — the normal
  // reopened shape, so the redraft still sees why the merge fell short (#158 review #1).
  const verification = live.find((gap) => gap.source === "verification");
  assert.ok(verification, "a live verification row carries the note forward");
  assert.equal(verification?.note, "retry cap hit");
  assert.ok(
    live.some((gap) => gap.source === "auto"),
    "the surviving auto gap is untouched"
  );
  // Both share the summary, so candidacy dedups them into a single candidate — no duplicate.
  const candidates = await store.listGapCandidates(50);
  assert.equal(candidates.filter((c) => c.summary === summary).length, 1, "a single candidate, not a duplicate");
});

test("retryParkedGap is a no-op on a question that is not parked", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({
    question: "vaccines?",
    chatProvider: "codex",
    answer: lowGapAnswer,
    retrievedSectionIds: []
  });
  const before = await store.get(log.id);
  const after = await store.retryParkedGap(log.id);
  assert.deepEqual(after?.gaps, before?.gaps, "unchanged");
});

test("dismissParkedGap abandons only the parked topic and never re-clusters it", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({
    question: "vaccines?",
    chatProvider: "codex",
    answer: lowGapAnswer,
    retrievedSectionIds: []
  });
  const summary = lowGapAnswer.gaps![0]!.summary;
  await store.recordVerificationGap(log.id, { summary, note: "retry cap hit", parked: true });

  const dismissed = await store.dismissParkedGap(log.id);

  const live = (dismissed?.gaps ?? []).filter((gap) => !gap.resolvedAt && !gap.dismissedAt && gap.summary === summary);
  assert.equal(live.length, 0, "no live gaps remain for the parked topic");
  assert.ok(
    (dismissed?.gaps ?? [])
      .filter((gap) => gap.summary === summary)
      .every((gap) => gap.dismissedReason === "human_dismiss"),
    "the parked topic's gaps were dismissed by the human"
  );
  assert.equal(
    (await store.listGapCandidates(50)).filter((c) => c.summary === summary).length,
    0,
    "the parked topic never re-clusters"
  );
});

test("dismissParkedGap does NOT collaterally dismiss an unrelated topic on a multi-topic question (#158 review #2)", async () => {
  const store = new InMemoryQuestionLogStore();
  // One question exposing two topics: S1 (parked) and S2 (a live manual gap).
  const log = await store.record({ question: "multi?", chatProvider: "codex", retrievedSectionIds: [] });
  await store.recordManualGap(log.id, "S2 unrelated topic");
  await store.recordVerificationGap(log.id, { summary: "S1 parked topic", note: "cap hit", parked: true });

  const dismissed = await store.dismissParkedGap(log.id);

  const s2 = (dismissed?.gaps ?? []).find((gap) => gap.summary === "S2 unrelated topic");
  assert.ok(s2 && !s2.dismissedAt && !s2.resolvedAt, "the unrelated S2 gap survives the dismissal");
  const s1Live = (dismissed?.gaps ?? []).some(
    (gap) => gap.summary === "S1 parked topic" && !gap.dismissedAt && !gap.resolvedAt
  );
  assert.equal(s1Live, false, "the parked S1 topic is dismissed");
  // With S1 unparked and S2 never parked, S2 re-enters candidacy.
  assert.ok(
    (await store.listGapCandidates(50)).some((c) => c.summary === "S2 unrelated topic"),
    "S2 re-enters candidacy once the question is no longer parked"
  );
});

test("listParkedQuestions returns parked questions with their note, excluding retried/dismissed ones", async () => {
  const store = new InMemoryQuestionLogStore();
  const parkedLog = await store.record({
    question: "How do I configure X?",
    chatProvider: "codex",
    retrievedSectionIds: []
  });
  await store.recordVerificationGap(parkedLog.id, {
    summary: "How to configure X",
    note: "awaiting a human",
    parked: true
  });
  const retriedLog = await store.record({ question: "other?", chatProvider: "codex", retrievedSectionIds: [] });
  await store.recordVerificationGap(retriedLog.id, { summary: "other", note: "n", parked: true });
  await store.retryParkedGap(retriedLog.id);

  const parked = await store.listParkedQuestions(50);
  assert.equal(parked.length, 1, "only the still-parked question is listed");
  assert.equal(parked[0]?.questionId, parkedLog.id);
  assert.equal(parked[0]?.summary, "How to configure X");
  assert.equal(parked[0]?.note, "awaiting a human");
  assert.ok(parked[0]?.parkedAt);
});

// Issue #168: updateAnswer used to bump the gap-catalog revision unconditionally,
// so an identical re-answer forced the reconciler to re-run its metered reshape on
// an unchanged candidate set. It now bumps only when the answer-derived gaps (or
// their flow) actually changed.

test("updateAnswer does not bump the catalog revision when the re-answer's gaps are identical", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({
    question: "vaccines?",
    chatProvider: "codex",
    answer: lowGapAnswer,
    retrievedSectionIds: []
  });
  const before = await store.getGapCatalogRevision();

  // Re-answer with the SAME gap (a different provider run reaching the same
  // conclusion): nothing about the candidate set changed.
  await store.updateAnswer(log.id, { answer: lowGapAnswer, chatProvider: "openai-compatible" });

  assert.equal(await store.getGapCatalogRevision(), before, "an identical re-answer does not bump the revision");
  // The answer text/provider still updated even though the gaps were untouched.
  const stored = await store.get(log.id);
  assert.equal(stored?.chatProvider, "openai-compatible");
});

test("updateAnswer bumps the catalog revision when the re-answer changes the gaps", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({
    question: "react + export?",
    chatProvider: "codex",
    answer: lowGapAnswer,
    retrievedSectionIds: []
  });
  const before = await store.getGapCatalogRevision();

  // A genuinely different set of gaps must still advance the revision.
  await store.updateAnswer(log.id, { answer: multiGapAnswer });

  assert.ok((await store.getGapCatalogRevision()) > before, "a changed gap set advances the revision");
});

test("updateAnswer bumps the catalog revision when the gaps move to a newly-decided flow", async () => {
  const store = new InMemoryQuestionLogStore();
  // Recorded before the watcher decided a flow (default/un-routed).
  const log = await store.record({
    question: "vaccines?",
    chatProvider: "codex",
    answer: lowGapAnswer,
    retrievedSectionIds: []
  });
  const beforeF1 = await store.getGapCatalogRevision("f1");

  // Same gaps, but the completion now assigns a flow — the gaps leave the default
  // flow's candidate set and join f1's, so f1's reconciler must notice.
  await store.updateAnswer(log.id, { answer: lowGapAnswer, flowId: "f1" });

  assert.ok(
    (await store.getGapCatalogRevision("f1")) > beforeF1,
    "moving gaps to a new flow advances that flow's revision"
  );
});

// --- 'unhelpful' feedback on a confident answer raises a 'feedback' gap (#241) ---

const confidentAnswer: AnswerResult = {
  answer: "Set FOO=1 and restart the service.",
  confidence: "high",
  citations: [],
  gaps: []
};

test("recordFeedback('unhelpful') on a confident answer raises a 'feedback' gap that enters candidacy", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({
    question: "How do I enable FOO?",
    chatProvider: "codex",
    answer: confidentAnswer,
    retrievedSectionIds: []
  });
  const before = await store.getGapCatalogRevision();

  const updated = await store.recordFeedback(log.id, "unhelpful");

  assert.equal(updated?.feedback, "unhelpful");
  assert.deepEqual(updated?.gaps, [{ summary: "How do I enable FOO?", source: "feedback" }]);
  assert.ok((await store.getGapCatalogRevision()) > before, "the candidate set changed, so the revision advances");

  const candidates = await store.listGapCandidates(50);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.summary, "How do I enable FOO?");
  assert.deepEqual(candidates[0]?.questionIds, [log.id]);
});

test("recordFeedback('unhelpful') on a low-confidence answer raises no feedback gap", async () => {
  const store = new InMemoryQuestionLogStore();
  // The low answer already carries its own 'auto' gap — an unhelpful verdict on
  // it adds nothing the system does not already know.
  const log = await store.record({
    question: "vaccines?",
    chatProvider: "codex",
    answer: lowGapAnswer,
    retrievedSectionIds: []
  });

  const updated = await store.recordFeedback(log.id, "unhelpful");

  assert.equal(updated?.feedback, "unhelpful");
  assert.ok(!(updated?.gaps ?? []).some((gap) => gap.source === "feedback"));
});

test("repeated 'unhelpful' keeps one feedback gap; 'helpful' withdraws it", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({
    question: "How do I enable FOO?",
    chatProvider: "codex",
    answer: confidentAnswer,
    retrievedSectionIds: []
  });

  await store.recordFeedback(log.id, "unhelpful");
  const afterFirst = await store.getGapCatalogRevision();
  const repeated = await store.recordFeedback(log.id, "unhelpful");

  assert.equal((repeated?.gaps ?? []).filter((gap) => gap.source === "feedback").length, 1);
  assert.equal(await store.getGapCatalogRevision(), afterFirst, "a repeated verdict is a candidate no-op");

  const withdrawn = await store.recordFeedback(log.id, "helpful");

  assert.equal(withdrawn?.feedback, "helpful");
  assert.ok(!(withdrawn?.gaps ?? []).some((gap) => gap.source === "feedback"));
  assert.ok((await store.getGapCatalogRevision()) > afterFirst, "the withdrawal advances the revision");
  assert.equal((await store.listGapCandidates(50)).length, 0);
});

test("re-answering preserves a feedback gap alongside manual rows", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({
    question: "How do I enable FOO?",
    chatProvider: "codex",
    answer: confidentAnswer,
    retrievedSectionIds: []
  });
  await store.recordFeedback(log.id, "unhelpful");

  // A re-answer replaces only the answer-derived (auto/followup) gaps.
  const updated = await store.updateAnswer(log.id, { answer: lowGapAnswer });

  assert.ok(
    (updated?.gaps ?? []).some((gap) => gap.source === "feedback"),
    "the feedback gap survives the re-answer"
  );
  assert.ok((updated?.gaps ?? []).some((gap) => gap.source === "auto"));
});

test("recordFeedback('unhelpful') on a verification re-ask log raises nothing", async () => {
  const store = new InMemoryQuestionLogStore();
  const reask = await store.record({
    question: "vaccines?",
    chatProvider: "codex",
    answer: confidentAnswer,
    retrievedSectionIds: [],
    purpose: "verification"
  });

  const updated = await store.recordFeedback(reask.id, "unhelpful");

  assert.equal(updated?.feedback, "unhelpful");
  assert.deepEqual(updated?.gaps ?? [], []);
});

// --- Multi-turn conversations (#239) ---------------------------------------

test("listConversationTurns returns answered live turns oldest-first, capped and excluding in-flight/other conversations", async () => {
  const store = new InMemoryQuestionLogStore();
  const conversationId = "conv-1";

  // Two answered turns in the conversation, oldest first.
  const first = await store.record({ question: "Q1", chatProvider: "codex", retrievedSectionIds: [], conversationId });
  await store.updateAnswer(first.id, { answer: confidentAnswer });
  const second = await store.record({ question: "Q2", chatProvider: "codex", retrievedSectionIds: [], conversationId });
  await store.updateAnswer(second.id, { answer: confidentAnswer });

  // An in-flight (unanswered) turn in the same conversation must be excluded.
  await store.record({ question: "Q3-inflight", chatProvider: "codex", retrievedSectionIds: [], conversationId });
  // A turn in a different conversation must be excluded.
  const other = await store.record({
    question: "OtherQ",
    chatProvider: "codex",
    retrievedSectionIds: [],
    conversationId: "conv-2"
  });
  await store.updateAnswer(other.id, { answer: confidentAnswer });

  const turns = await store.listConversationTurns(conversationId, 6);
  assert.deepEqual(
    turns.map((turn) => turn.question),
    ["Q1", "Q2"],
    "answered turns of this conversation, oldest-first"
  );

  // The cap keeps the most recent N.
  const capped = await store.listConversationTurns(conversationId, 1);
  assert.deepEqual(
    capped.map((turn) => turn.question),
    ["Q2"],
    "the cap keeps the most recent turn"
  );
});

test("updateAnswer persists the watcher's condensed standaloneQuestion", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({
    question: "What about the EU?",
    chatProvider: "codex",
    retrievedSectionIds: [],
    conversationId: "c"
  });

  const updated = await store.updateAnswer(log.id, {
    answer: confidentAnswer,
    standaloneQuestion: "What is the data retention policy for the EU region?"
  });

  assert.equal(updated?.standaloneQuestion, "What is the data retention policy for the EU region?");
});

test("a manual gap on a follow-up falls back to the condensed standalone form, not the terse question", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({ question: "What about the EU?", chatProvider: "codex", retrievedSectionIds: [] });
  await store.updateAnswer(log.id, {
    answer: confidentAnswer,
    standaloneQuestion: "What is the data retention policy for the EU region?"
  });

  const flagged = await store.recordManualGap(log.id);
  const manual = (flagged?.gaps ?? []).find((gap) => gap.source === "manual");
  assert.equal(
    manual?.summary,
    "What is the data retention policy for the EU region?",
    "the gap seeds from the self-contained form so it can cluster with siblings"
  );
});

test("an 'unhelpful' feedback gap on a follow-up falls back to the condensed standalone form", async () => {
  const store = new InMemoryQuestionLogStore();
  const log = await store.record({ question: "and the EU?", chatProvider: "codex", retrievedSectionIds: [] });
  await store.updateAnswer(log.id, {
    answer: confidentAnswer,
    standaloneQuestion: "What is the data retention policy for the EU region?"
  });

  const rated = await store.recordFeedback(log.id, "unhelpful");
  const feedbackGap = (rated?.gaps ?? []).find((gap) => gap.source === "feedback");
  assert.equal(feedbackGap?.summary, "What is the data retention policy for the EU region?");
});
