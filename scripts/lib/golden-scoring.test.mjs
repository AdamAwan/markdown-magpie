import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregate, compareToBaseline, scoreCase } from "./golden-scoring.mjs";

const DOC_TEXTS = new Map([
  ["backups.md", "How long a backup is retained: nightly database backups are retained for 35 days."]
]);

const CASE = {
  id: "backup-retention",
  question: "How long are database backups retained?",
  expect: {
    routing: { mode: "routed", flowId: "aurora" },
    confidence: "high",
    citedDocs: ["backups.md"],
    answerContains: ["35"],
    gaps: "none",
    verification: "grounded"
  }
};

function outcome(overrides = {}) {
  return {
    answer: {
      answer: "How long a backup is retained: nightly database backups are retained for 35 days.",
      confidence: "high",
      citations: [{ path: "backups.md", sectionId: "r:backups.md:2" }],
      trace: {
        routing: { mode: "routed", flowId: "aurora", method: "chat" },
        verification: { status: "grounded" }
      },
      ...overrides
    }
  };
}

describe("scoreCase", () => {
  it("passes a fully conforming outcome", () => {
    const score = scoreCase(CASE, outcome(), DOC_TEXTS);
    assert.equal(score.passed, true);
    assert.equal(score.checks.groundedness, 1);
    assert.equal(score.checks.citationPrecision, 1);
    assert.equal(score.checks.citationRecall, 1);
  });

  it("fails confidence calibration on a mismatch", () => {
    const score = scoreCase(CASE, outcome({ confidence: "medium" }), DOC_TEXTS);
    assert.equal(score.checks.confidence, false);
    assert.equal(score.passed, false);
  });

  it("penalises a spurious citation in precision but not recall", () => {
    const score = scoreCase(
      CASE,
      outcome({
        citations: [
          { path: "backups.md", sectionId: "a" },
          { path: "deployment.md", sectionId: "b" }
        ]
      }),
      DOC_TEXTS
    );
    assert.equal(score.checks.citationPrecision, 0.5);
    assert.equal(score.checks.citationRecall, 1);
    assert.equal(score.passed, false);
  });

  it("scores groundedness against the cited documents only", () => {
    const score = scoreCase(
      CASE,
      outcome({ answer: "Backups are kept forever and replicated to the moon." }),
      DOC_TEXTS
    );
    assert.equal(score.checks.groundedness, 0);
    assert.equal(score.passed, false);
  });

  it("treats coverage meta-statements as non-factual for groundedness", () => {
    const score = scoreCase(
      CASE,
      outcome({
        answer:
          "How long a backup is retained: nightly database backups are retained for 35 days. The knowledge base does not cover: cold storage."
      }),
      DOC_TEXTS
    );
    assert.equal(score.checks.groundedness, 1);
  });

  it("checks behaviour expectations (gaps, verification status)", () => {
    const withGap = scoreCase(CASE, outcome({ gaps: [{ summary: "x" }] }), DOC_TEXTS);
    assert.equal(withGap.checks.behaviour, false);

    const gapCase = {
      id: "gap",
      expect: { routing: { mode: "routed" }, confidence: "low", citedDocs: [], gaps: "some", verification: "skipped" }
    };
    const gapOutcome = {
      answer: {
        answer: "The knowledge base does not cover: SLA.",
        confidence: "low",
        citations: [],
        gaps: [{ summary: "SLA" }],
        trace: { routing: { mode: "routed", flowId: "aurora" }, verification: { status: "skipped" } }
      }
    };
    const score = scoreCase(gapCase, gapOutcome, DOC_TEXTS);
    assert.equal(score.passed, true);
    assert.equal(score.checks.groundedness, null, "no citations -> groundedness not applicable");
  });
});

describe("aggregate", () => {
  it("averages booleans and fractions, skipping non-applicable checks", () => {
    const dimensions = aggregate([
      {
        checks: {
          routing: true,
          confidence: true,
          citationPrecision: 1,
          citationRecall: 1,
          groundedness: 1,
          content: true,
          behaviour: true
        }
      },
      {
        checks: {
          routing: false,
          confidence: true,
          citationPrecision: 0.5,
          citationRecall: 1,
          groundedness: null,
          content: null,
          behaviour: false
        }
      }
    ]);
    assert.equal(dimensions.routing_accuracy, 0.5);
    assert.equal(dimensions.confidence_calibration, 1);
    assert.equal(dimensions.citation_precision, 0.75);
    assert.equal(dimensions.groundedness, 1);
    assert.equal(dimensions.answer_content, 1);
    assert.equal(dimensions.behaviour_compliance, 0.5);
  });
});

describe("compareToBaseline", () => {
  const baseline = {
    dimensions: { routing_accuracy: 1, groundedness: 0.9 },
    cases: { "backup-retention": true, "known-flaky": false }
  };

  it("flags dimension and case regressions", () => {
    const { regressions } = compareToBaseline(
      {
        dimensions: { routing_accuracy: 0.8, groundedness: 0.9 },
        cases: { "backup-retention": false, "known-flaky": false }
      },
      baseline
    );
    assert.deepEqual(
      regressions.map((r) => `${r.kind}:${r.name}`),
      ["dimension:routing_accuracy", "case:backup-retention"]
    );
  });

  it("reports improvements without failing", () => {
    const { regressions, improvements } = compareToBaseline(
      {
        dimensions: { routing_accuracy: 1, groundedness: 1 },
        cases: { "backup-retention": true, "known-flaky": true }
      },
      baseline
    );
    assert.equal(regressions.length, 0);
    assert.deepEqual(
      improvements.map((r) => `${r.kind}:${r.name}`),
      ["dimension:groundedness", "case:known-flaky"]
    );
  });

  it("treats a missing dimension as a regression", () => {
    const { regressions } = compareToBaseline({ dimensions: { routing_accuracy: 1 }, cases: {} }, baseline);
    assert.ok(regressions.some((r) => r.name === "groundedness" && r.current === null));
  });
});
