import assert from "node:assert/strict";
import test from "node:test";
import type { AssertedClaim, QuestionnaireItem } from "@magpie/core";
import { click, renderDom } from "../test/dom";
import { ImportedAnswerPanel } from "./ImportedAnswerPanel";
import { parseTwoColumnPaste } from "./questionnaireItems";

function importedItem(overrides: Partial<QuestionnaireItem> = {}): QuestionnaireItem {
  return {
    id: "i-0",
    questionnaireId: "qn-1",
    position: 0,
    question: "Do you hold ISO 27001?",
    status: "answered",
    answer: "We hold ISO 27001, certified 2022.",
    importedAnswer: "Yes, since 2021.",
    importVerdict: "divergent",
    staleAtApproval: false,
    citations: [],
    ...overrides
  };
}

function finding(overrides: Partial<AssertedClaim> = {}): AssertedClaim {
  return {
    id: "ac-1",
    flowId: "security",
    itemId: "i-0",
    kind: "unsubstantiated",
    question: "Do you hold ISO 27001?",
    claim: "We have held ISO 27001 since 2021.",
    positions: [],
    status: "open",
    fingerprint: "fp",
    firstSeenAt: "2026-08-11T00:00:00.000Z",
    lastSeenAt: "2026-08-11T00:00:00.000Z",
    seenCount: 1,
    ...overrides
  };
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(text));
  assert.ok(match, `expected a button containing "${text}"`);
  return match as HTMLButtonElement;
}

test("renders both answers side by side with the stage-1 verdict", async () => {
  const { container } = await renderDom(
    <ImportedAnswerPanel item={importedItem()} findings={[]} onApprove={() => {}} />
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("Yes, since 2021."), "the previously-given answer must be shown");
  assert.ok(text.includes("We hold ISO 27001, certified 2022."), "Magpie's answer must be shown");
  assert.ok(text.includes("divergent"));
});

test("an uncovered item says so rather than showing a blank column", async () => {
  const { container } = await renderDom(
    <ImportedAnswerPanel
      item={importedItem({ importVerdict: "uncovered", status: "unanswerable", answer: undefined })}
      findings={[]}
      onApprove={() => {}}
    />
  );
  assert.ok((container.textContent ?? "").includes("does not cover this"));
});

test("approve buttons report which wording the reviewer picked", async () => {
  const picked: string[] = [];
  const { container } = await renderDom(
    <ImportedAnswerPanel item={importedItem()} findings={[]} onApprove={(use) => picked.push(use)} />
  );
  await click(buttonByText(container, "Approve imported"));
  await click(buttonByText(container, "Approve Magpie"));
  assert.deepEqual(picked, ["imported", "magpie"]);
});

test("an open finding blocks approving the imported wording but not Magpie's", async () => {
  const { container } = await renderDom(
    <ImportedAnswerPanel item={importedItem()} findings={[finding()]} onApprove={() => {}} />
  );
  assert.equal(buttonByText(container, "Approve imported").disabled, true);
  assert.equal(buttonByText(container, "Approve Magpie").disabled, false);
});

test("findings are shown with their kind and source positions", async () => {
  const { container } = await renderDom(
    <ImportedAnswerPanel
      item={importedItem()}
      findings={[
        finding({
          kind: "contradicted",
          claim: "Logs are retained for 1 year.",
          positions: [{ sourceId: "policy", path: "security/retention.md", statement: "retained for 60 days" }]
        })
      ]}
      onApprove={() => {}}
    />
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("contradicted"));
  assert.ok(text.includes("security/retention.md"));
  assert.ok(text.includes("retained for 60 days"));
});

test("no approve actions until the item has actually been answered", async () => {
  const { container } = await renderDom(
    <ImportedAnswerPanel item={importedItem({ status: "pending" })} findings={[]} onApprove={() => {}} />
  );
  assert.equal([...container.querySelectorAll("button")].length, 0);
});

// --- the paste parser (pure; the harness cannot type into a textarea) ---

test("parseTwoColumnPaste splits tab-separated question/answer pairs", () => {
  assert.deepEqual(parseTwoColumnPaste("Q1\tA1\nQ2\tA2"), [
    { question: "Q1", importedAnswer: "A1" },
    { question: "Q2", importedAnswer: "A2" }
  ]);
});

test("parseTwoColumnPaste tolerates a single column", () => {
  assert.deepEqual(parseTwoColumnPaste("Q1\nQ2"), [{ question: "Q1" }, { question: "Q2" }]);
});

test("parseTwoColumnPaste keeps a trailing notes column as answer content", () => {
  // Spreadsheet selections routinely carry one; dropping it would silently
  // discard part of the answer.
  assert.deepEqual(parseTwoColumnPaste("Q1\tA1\tnote"), [{ question: "Q1", importedAnswer: "A1\tnote" }]);
});

test("parseTwoColumnPaste drops blank lines and answer-less rows cleanly", () => {
  assert.deepEqual(parseTwoColumnPaste("Q1\tA1\n\n  \nQ2\t"), [
    { question: "Q1", importedAnswer: "A1" },
    { question: "Q2" }
  ]);
});
