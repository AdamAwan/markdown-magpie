import test from "node:test";
import assert from "node:assert/strict";
import type { SheetGrid, SheetMapping } from "@magpie/core";
import { applyMapping, PREVIEW_SAMPLE_ROWS } from "./apply-mapping.js";

const security: SheetGrid = {
  name: "Security",
  rows: [
    ["Acme Corp questionnaire", "", ""],
    ["Question", "Response", "Type"],
    ["Access control", "", ""],
    ["Do you enforce MFA?", "Yes, for all staff.", "Yes/No"],
    ["Do you encrypt at rest?", "", "Yes/No"],
    ["", "", ""],
    ["", "Reviewed by legal", ""]
  ]
};

const mapping: SheetMapping = {
  sheetIndex: 0,
  role: "questions",
  headerRow: 1,
  questionColumn: 0,
  answerColumn: 1,
  responseTypeColumn: 2,
  sectionHeadingColumn: 0,
  confidence: "high",
  reason: "header row names Question and Response"
};

test("question rows carry the previously-given answer, and only where there is one", () => {
  const { questions } = applyMapping([security], [mapping]);
  assert.deepEqual(questions, [
    { question: "Access control: Do you enforce MFA?", importedAnswer: "Yes, for all staff." },
    { question: "Access control: Do you encrypt at rest?" }
  ]);
});

test("rows at or above the header row are unclassified, never questions", () => {
  const { sheets } = applyMapping([security], [mapping]);
  const above = sheets[0].unclassifiedRows.find((row) => row.rowIndex === 0);
  assert.equal(above?.reason, "above_header");
});

test("a row with text outside the question column is surfaced, not dropped", () => {
  const { sheets } = applyMapping([security], [mapping]);
  const orphan = sheets[0].unclassifiedRows.find((row) => row.rowIndex === 6);
  assert.equal(orphan?.reason, "blank_question");
  assert.match(orphan?.question ?? "", /Reviewed by legal/);
});

test("a wholly blank row is neither a question nor triage noise", () => {
  const { sheets } = applyMapping([security], [mapping]);
  assert.equal(
    sheets[0].unclassifiedRows.some((row) => row.rowIndex === 5),
    false
  );
});

test("a section heading becomes the running prefix, not a question", () => {
  const { questions, sheets } = applyMapping([security], [mapping]);
  assert.equal(questions.length, 2);
  assert.ok(sheets[0].sampleRows.some((row) => row.kind === "heading" && row.question === "Access control"));
});

test("a promoted row becomes a question despite the rules that skipped it", () => {
  const { questions } = applyMapping([security], [mapping], { promoted: ["0:0"] });
  assert.equal(questions[0].question, "Acme Corp questionnaire");
  assert.equal(questions.length, 3);
});

test("an excluded sheet contributes nothing", () => {
  assert.deepEqual(applyMapping([security], [mapping], { excluded: [0] }).questions, []);
});

test("a sheet the model marked ignore contributes nothing", () => {
  assert.deepEqual(applyMapping([security], [{ ...mapping, role: "ignore" }]).questions, []);
});

test("two included sheets concatenate, each question prefixed by its sheet", () => {
  const privacy: SheetGrid = {
    name: "Privacy",
    rows: [
      ["Question", "Response"],
      ["Do you have a DPO?", "Yes."]
    ]
  };
  const privacyMapping: SheetMapping = { ...mapping, sheetIndex: 1, headerRow: 0, sectionHeadingColumn: null };
  const { questions } = applyMapping([security, privacy], [mapping, privacyMapping]);
  assert.equal(questions.at(-1)?.question, "Privacy — Do you have a DPO?");
  assert.ok(questions[0].question.startsWith("Security — "));
});

test("a single included sheet takes no sheet prefix", () => {
  const { questions } = applyMapping([security], [mapping]);
  assert.equal(
    questions.every((entry) => !entry.question.startsWith("Security — ")),
    true
  );
});

test("a sheet with no question column classifies every row as unmappable", () => {
  const { questions, sheets } = applyMapping([security], [{ ...mapping, questionColumn: null }]);
  assert.equal(questions.length, 0);
  assert.ok(sheets[0].unclassifiedCount > 0);
  assert.ok(sheets[0].unclassifiedRows.every((row) => row.reason === "no_mapping" || row.reason === "above_header"));
});

test("an in-line banner in the question column is a heading, not a question", () => {
  const banner: SheetGrid = {
    name: "Sheet1",
    rows: [
      ["Question", "Response"],
      ["Data protection", ""],
      ["Do you have a DPO?", "Yes."]
    ]
  };
  const { questions } = applyMapping([banner], [{ ...mapping, headerRow: 0, sectionHeadingColumn: 0 }]);
  assert.deepEqual(questions, [{ question: "Data protection: Do you have a DPO?", importedAnswer: "Yes." }]);
});

test("previews are bounded but counts are not", () => {
  const big: SheetGrid = { name: "Big", rows: Array.from({ length: 400 }, (_, index) => [`Q${index}`, `A${index}`]) };
  const { sheets, questions } = applyMapping(
    [big],
    [{ ...mapping, headerRow: null, sectionHeadingColumn: null, responseTypeColumn: null }]
  );
  assert.equal(questions.length, 400);
  assert.equal(sheets[0].sampleRows.length, PREVIEW_SAMPLE_ROWS);
  assert.equal(sheets[0].questionCount, 400);
});
