// Scoring for the golden-question regression eval (scripts/eval-golden.ts).
// Pure functions over a golden case's expectations and the stored question
// log, so the whole scorer is unit-testable without a running stack.
//
// Dimensions (issue #241): routing accuracy, confidence calibration, citation
// precision/recall, groundedness (answer sentences must appear in the cited
// documents' text — computed in code, not trusted from the model), answer
// content, and behaviour compliance (gap/out-of-scope/flow-selection/
// verification outcomes). Each aggregates to [0,1]; the committed baseline
// (scripts/fixtures/golden-baseline.json) is the regression anchor.

import { splitSentences } from "./golden-core.mjs";

const NOT_COVERED_PREFIX = "The knowledge base does not cover";

function normalise(text) {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

// One case's checks. `outcome` is the stored QuestionLog; `docTexts` maps a
// document basename (e.g. "backups.md") to its full markdown text.
export function scoreCase(caseDef, outcome, docTexts) {
  const expect = caseDef.expect;
  const answer = outcome.answer ?? {};
  const trace = answer.trace;

  const checks = {};

  // Routing: mode must match; when the expectation names a flow it must match too.
  const routing = trace?.routing;
  checks.routing =
    routing !== undefined &&
    routing.mode === expect.routing.mode &&
    (expect.routing.flowId === undefined || routing.flowId === expect.routing.flowId);

  checks.confidence = answer.confidence === expect.confidence;

  const actualDocs = [...new Set((answer.citations ?? []).map((citation) => basename(citation.path)))];
  const expectedDocs = expect.citedDocs ?? [];
  const matchedActual = actualDocs.filter((doc) => expectedDocs.includes(doc));
  checks.citationPrecision = actualDocs.length > 0 ? matchedActual.length / actualDocs.length : 1;
  checks.citationRecall =
    expectedDocs.length > 0
      ? expectedDocs.filter((doc) => actualDocs.includes(doc)).length / expectedDocs.length
      : 1;

  // Groundedness only applies when the answer cites something: every factual
  // sentence must appear in a cited document. Coverage meta-statements are not
  // factual claims.
  if (actualDocs.length > 0 && typeof answer.answer === "string") {
    const citedText = normalise(actualDocs.map((doc) => docTexts.get(doc) ?? "").join(" "));
    const factual = splitSentences(answer.answer).filter(
      (sentence) => !sentence.startsWith(NOT_COVERED_PREFIX)
    );
    checks.groundedness =
      factual.length > 0
        ? factual.filter((sentence) => citedText.includes(normalise(sentence))).length / factual.length
        : 1;
  } else {
    checks.groundedness = null;
  }

  if (expect.answerContains || expect.answerExcludes) {
    const text = (answer.answer ?? "").toLowerCase();
    const contains = (expect.answerContains ?? []).every((term) => text.includes(term.toLowerCase()));
    const excludes = (expect.answerExcludes ?? []).every((term) => !text.includes(term.toLowerCase()));
    checks.content = contains && excludes;
  } else {
    checks.content = null;
  }

  const behaviours = [];
  if (expect.gaps === "none") {
    behaviours.push((answer.gaps ?? []).length === 0);
  } else if (expect.gaps === "some") {
    behaviours.push((answer.gaps ?? []).length >= 1);
  }
  if (expect.outOfScope !== undefined) {
    behaviours.push(Boolean(answer.outOfScope) === expect.outOfScope);
  }
  if (expect.flowSelectionRequired !== undefined) {
    behaviours.push(Boolean(answer.flowSelectionRequired) === expect.flowSelectionRequired);
  }
  if (expect.verification !== undefined) {
    behaviours.push(trace?.verification?.status === expect.verification);
  }
  checks.behaviour = behaviours.length > 0 ? behaviours.every(Boolean) : null;

  const passed =
    checks.routing &&
    checks.confidence &&
    checks.citationPrecision >= 1 &&
    checks.citationRecall >= 1 &&
    (checks.groundedness === null || checks.groundedness >= 1) &&
    (checks.content === null || checks.content) &&
    (checks.behaviour === null || checks.behaviour);

  return { id: caseDef.id, checks, passed };
}

function basename(path) {
  const value = typeof path === "string" ? path : "";
  const index = value.lastIndexOf("/");
  return index === -1 ? value : value.slice(index + 1);
}

// Aggregates per-case checks into the dimension scores tracked over time.
export function aggregate(caseScores) {
  const mean = (values) => {
    const present = values.filter((value) => value !== null && value !== undefined);
    if (present.length === 0) {
      return 1;
    }
    const total = present.reduce((sum, value) => sum + (typeof value === "boolean" ? (value ? 1 : 0) : value), 0);
    return round(total / present.length);
  };
  return {
    routing_accuracy: mean(caseScores.map((score) => score.checks.routing)),
    confidence_calibration: mean(caseScores.map((score) => score.checks.confidence)),
    citation_precision: mean(caseScores.map((score) => score.checks.citationPrecision)),
    citation_recall: mean(caseScores.map((score) => score.checks.citationRecall)),
    groundedness: mean(caseScores.map((score) => score.checks.groundedness)),
    answer_content: mean(caseScores.map((score) => score.checks.content)),
    behaviour_compliance: mean(caseScores.map((score) => score.checks.behaviour))
  };
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

// Baseline comparison. A dimension scoring below its baseline, or a case that
// passed at baseline time and fails now, is a regression — the eval fails
// loudly. Improvements are reported so the baseline can be re-pinned.
export function compareToBaseline(current, baseline) {
  const epsilon = 1e-9;
  const regressions = [];
  const improvements = [];
  for (const [dimension, baselineScore] of Object.entries(baseline.dimensions ?? {})) {
    const currentScore = current.dimensions[dimension];
    if (currentScore === undefined) {
      regressions.push({ kind: "dimension", name: dimension, baseline: baselineScore, current: null });
    } else if (currentScore < baselineScore - epsilon) {
      regressions.push({ kind: "dimension", name: dimension, baseline: baselineScore, current: currentScore });
    } else if (currentScore > baselineScore + epsilon) {
      improvements.push({ kind: "dimension", name: dimension, baseline: baselineScore, current: currentScore });
    }
  }
  for (const [caseId, passedAtBaseline] of Object.entries(baseline.cases ?? {})) {
    const nowPassed = current.cases[caseId];
    if (passedAtBaseline && nowPassed === false) {
      regressions.push({ kind: "case", name: caseId, baseline: true, current: false });
    } else if (!passedAtBaseline && nowPassed === true) {
      improvements.push({ kind: "case", name: caseId, baseline: false, current: true });
    }
  }
  return { regressions, improvements };
}
