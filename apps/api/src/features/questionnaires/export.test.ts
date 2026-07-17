import { test } from "node:test";
import assert from "node:assert/strict";
import type { Questionnaire, QuestionnaireItem } from "@magpie/core";
import { exportQuestionnaire } from "./export.js";

function item(
  overrides: Partial<QuestionnaireItem> & Pick<QuestionnaireItem, "position" | "question" | "status">
): QuestionnaireItem {
  return {
    id: `i-${overrides.position}`,
    questionnaireId: "q-1",
    staleAtApproval: false,
    citations: [],
    ...overrides
  };
}

function questionnaire(items: QuestionnaireItem[]): Questionnaire {
  return {
    id: "q-1",
    name: "Acme SIG Q3",
    flowId: "security",
    status: "open",
    createdAt: "2026-07-16T00:00:00.000Z",
    items
  };
}

test("markdown export renders numbered question/answer pairs and marks unanswerable items", () => {
  const markdown = exportQuestionnaire(
    questionnaire([
      item({
        position: 0,
        question: "What certs, if any, do you hold?",
        status: "answered",
        answer: 'We hold "ISO 27001", SOC 2.'
      }),
      item({
        position: 1,
        question: "Where is data stored?",
        status: "unanswerable",
        answer: "I could not find this."
      })
    ]),
    "md"
  );
  assert.match(markdown, /# Acme SIG Q3/);
  assert.match(markdown, /## 1\. What certs, if any, do you hold\?/);
  assert.match(markdown, /We hold "ISO 27001", SOC 2\./);
  assert.match(markdown, /## 2\. Where is data stored\?/);
  assert.match(markdown, /_No answer available\._/);
  assert.ok(!markdown.includes("I could not find this."), "unanswerable text never leaks into the export");
});

test("csv export quotes fields containing commas and quotes per RFC 4180", () => {
  const csv = exportQuestionnaire(
    questionnaire([
      item({
        position: 0,
        question: "What certs, if any, do you hold?",
        status: "answered",
        answer: 'We hold "ISO 27001", SOC 2.'
      }),
      item({
        position: 1,
        question: "Where is data stored?",
        status: "unanswerable",
        answer: "I could not find this."
      })
    ]),
    "csv"
  );
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "position,question,answer,status,confidence,outcome");
  assert.equal(lines[1], '1,"What certs, if any, do you hold?","We hold ""ISO 27001"", SOC 2.",answered,,');
  assert.equal(lines[2], "2,Where is data stored?,,unanswerable,,");
});

test("markdown shows a low-confidence answer with a review badge", () => {
  const q = questionnaire([
    item({ position: 0, question: "Q", status: "answered", answer: "Grounded answer.", confidence: "low" })
  ]);
  const md = exportQuestionnaire(q, "md");
  assert.match(md, /Low confidence/);
  assert.match(md, /Grounded answer\./);
  assert.doesNotMatch(md, /No answer available/);
});

test("markdown blanks only a truly unanswerable item", () => {
  const q = questionnaire([
    item({ position: 0, question: "Q", status: "unanswerable", answer: undefined, confidence: undefined })
  ]);
  const md = exportQuestionnaire(q, "md");
  assert.match(md, /_No answer available\._/);
});

test("csv carries a confidence column", () => {
  const q = questionnaire([
    item({ position: 0, question: "Q", status: "answered", answer: "A", confidence: "medium" })
  ]);
  const csv = exportQuestionnaire(q, "csv");
  assert.match(csv.split("\r\n")[0]!, /confidence/);
  assert.match(csv, /medium/);
});
