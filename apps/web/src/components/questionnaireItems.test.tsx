import assert from "node:assert/strict";
import test from "node:test";
import type { QuestionnaireItem } from "@magpie/core";
import { changeReasonText, itemLabel, itemTone } from "./questionnaireItems";

function item(overrides: Partial<QuestionnaireItem>): QuestionnaireItem {
  return {
    id: "i-0",
    questionnaireId: "qn-1",
    position: 0,
    question: "q?",
    status: "answered",
    staleAtApproval: false,
    citations: [],
    ...overrides
  };
}

test("itemTone maps status and outcome to a status tone", () => {
  assert.equal(itemTone(item({ status: "unanswerable" })), "failed");
  assert.equal(itemTone(item({ status: "pending" })), "pending");
  assert.equal(itemTone(item({ status: "answering" })), "pending");
  assert.equal(itemTone(item({ status: "answered", outcome: "reused" })), "completed");
  assert.equal(itemTone(item({ status: "answered", outcome: "changed" })), "running");
  assert.equal(itemTone(item({ status: "answered", outcome: "fresh" })), "neutral");
});

test("itemLabel prefers status, then outcome", () => {
  assert.equal(itemLabel(item({ status: "pending" })), "queued");
  assert.equal(itemLabel(item({ status: "answering" })), "answering");
  assert.equal(itemLabel(item({ status: "unanswerable" })), "unanswerable");
  assert.equal(itemLabel(item({ status: "approved" })), "approved");
  assert.equal(itemLabel(item({ status: "answered", outcome: "reused" })), "reused");
  assert.equal(itemLabel(item({ status: "answered" })), "answered");
});

test("changeReasonText explains each re-answer kind", () => {
  assert.equal(changeReasonText(item({})), "");
  assert.match(
    changeReasonText(
      item({
        changeReason: { kind: "section_changed", sectionId: "s", path: "data.md", heading: "Data", changedAt: "2026-06-03T00:00:00Z" }
      })
    ),
    /cited section “Data” changed on 2026-06-03\./
  );
  assert.match(
    changeReasonText(item({ changeReason: { kind: "section_missing", sectionId: "s", path: "data.md", heading: "Data" } })),
    /no longer exists/
  );
  assert.match(
    changeReasonText(item({ changeReason: { kind: "new_content", sectionId: "s", path: "data.md", heading: "Data" } })),
    /new relevant content appeared — Data/
  );
});
