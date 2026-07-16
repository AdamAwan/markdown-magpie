import { test } from "node:test";
import assert from "node:assert/strict";
import type { Questionnaire } from "@magpie/core";
import { exportQuestionnaire } from "./export.js";

function questionnaire(): Questionnaire {
  return {
    id: "q-1",
    name: "Acme SIG Q3",
    flowId: "security",
    status: "open",
    createdAt: "2026-07-16T00:00:00.000Z",
    items: [
      {
        id: "i-0",
        questionnaireId: "q-1",
        position: 0,
        question: "What certs, if any, do you hold?",
        status: "answered",
        answer: 'We hold "ISO 27001", SOC 2.',
        staleAtApproval: false,
        citations: []
      },
      {
        id: "i-1",
        questionnaireId: "q-1",
        position: 1,
        question: "Where is data stored?",
        status: "unanswerable",
        answer: "I could not find this.",
        staleAtApproval: false,
        citations: []
      }
    ]
  };
}

test("markdown export renders numbered question/answer pairs and marks unanswerable items", () => {
  const markdown = exportQuestionnaire(questionnaire(), "md");
  assert.match(markdown, /# Acme SIG Q3/);
  assert.match(markdown, /## 1\. What certs, if any, do you hold\?/);
  assert.match(markdown, /We hold "ISO 27001", SOC 2\./);
  assert.match(markdown, /## 2\. Where is data stored\?/);
  assert.match(markdown, /_No answer available\._/);
  assert.ok(!markdown.includes("I could not find this."), "unanswerable text never leaks into the export");
});

test("csv export quotes fields containing commas and quotes per RFC 4180", () => {
  const csv = exportQuestionnaire(questionnaire(), "csv");
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "position,question,answer,status");
  assert.equal(lines[1], '1,"What certs, if any, do you hold?","We hold ""ISO 27001"", SOC 2.",answered');
  assert.equal(lines[2], "2,Where is data stored?,,unanswerable");
});
