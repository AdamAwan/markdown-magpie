import assert from "node:assert/strict";
import test from "node:test";
import type { ImportSheetPreview, QuestionnaireImport, SheetMapping } from "@magpie/core";
import { changeValue, click, renderDom } from "../test/dom";
import { ImportMappingPreview, type ConfirmImportBody } from "./ImportMappingPreview";

const mapping: SheetMapping = {
  sheetIndex: 0,
  role: "questions",
  headerRow: 0,
  questionColumn: 0,
  answerColumn: 1,
  responseTypeColumn: null,
  sectionHeadingColumn: null,
  confidence: "high",
  reason: "header row names Question and Response"
};

function preview(overrides: Partial<ImportSheetPreview> = {}): ImportSheetPreview {
  return {
    sheetIndex: 0,
    name: "Security",
    rowCount: 4,
    columnCount: 3,
    questionCount: 1,
    unclassifiedCount: 1,
    sampleRows: [
      { sheetIndex: 0, rowIndex: 2, kind: "question", question: "Do you enforce MFA?", importedAnswer: "Yes." }
    ],
    unclassifiedRows: [
      { sheetIndex: 0, rowIndex: 3, kind: "unclassified", question: "Reviewed by legal", reason: "blank_question" }
    ],
    headerSample: [["Question", "Response", "Type"]],
    ...overrides
  };
}

function staged(overrides: Partial<QuestionnaireImport> = {}): QuestionnaireImport {
  return {
    id: "imp-1",
    flowId: "security",
    name: "Acme SIG",
    filename: "acme.xlsx",
    format: "xlsx",
    status: "mapped",
    mapping: [mapping],
    createdAt: "2026-08-11T00:00:00.000Z",
    ...overrides
  };
}

function findByLabel(container: HTMLElement, label: string): HTMLElement {
  const found = container.querySelector(`[aria-label="${label}"]`);
  assert.ok(found, `expected a control labelled "${label}"`);
  return found as HTMLElement;
}

function confirmButton(container: HTMLElement): HTMLElement {
  const button = [...container.querySelectorAll("button")].find((entry) =>
    entry.textContent?.includes("Create questionnaire")
  );
  assert.ok(button, "confirm button renders");
  return button;
}

test("confirming submits the detected mapping unchanged", async () => {
  const submitted: ConfirmImportBody[] = [];
  const { container, unmount } = await renderDom(
    <ImportMappingPreview
      data={{ import: staged(), preview: [preview()] }}
      onConfirm={(body) => submitted.push(body)}
      onDiscard={() => {}}
    />
  );
  try {
    await click(confirmButton(container));
    assert.deepEqual(submitted, [{ sheets: [{ sheetIndex: 0, include: true, mapping }] }]);
  } finally {
    unmount();
  }
});

test("an edited column wins over the model's proposal", async () => {
  const submitted: ConfirmImportBody[] = [];
  const { container, unmount } = await renderDom(
    <ImportMappingPreview
      data={{ import: staged(), preview: [preview()] }}
      onConfirm={(body) => submitted.push(body)}
      onDiscard={() => {}}
    />
  );
  try {
    const select = findByLabel(container, "Security · Question column");
    await changeValue(select as HTMLSelectElement, "1");
    await click(confirmButton(container));
    assert.equal(submitted[0].sheets[0].mapping.questionColumn, 1);
    // Untouched fields keep the proposal.
    assert.equal(submitted[0].sheets[0].mapping.answerColumn, 1);
  } finally {
    unmount();
  }
});

test("a column can be set back to none rather than guessed", async () => {
  const submitted: ConfirmImportBody[] = [];
  const { container, unmount } = await renderDom(
    <ImportMappingPreview
      data={{ import: staged(), preview: [preview()] }}
      onConfirm={(body) => submitted.push(body)}
      onDiscard={() => {}}
    />
  );
  try {
    await changeValue(findByLabel(container, "Security · Previous answer column") as HTMLSelectElement, "");
    await click(confirmButton(container));
    assert.equal(submitted[0].sheets[0].mapping.answerColumn, null);
  } finally {
    unmount();
  }
});

test("an excluded sheet is submitted as excluded, not omitted", async () => {
  const submitted: ConfirmImportBody[] = [];
  const instructions = preview({ sheetIndex: 1, name: "Instructions", questionCount: 0, sampleRows: [] });
  const { container, unmount } = await renderDom(
    <ImportMappingPreview
      data={{
        import: staged({ mapping: [mapping, { ...mapping, sheetIndex: 1 }] }),
        preview: [preview(), instructions]
      }}
      onConfirm={(body) => submitted.push(body)}
      onDiscard={() => {}}
    />
  );
  try {
    await click(findByLabel(container, "Include Instructions"));
    await click(confirmButton(container));
    assert.deepEqual(
      submitted[0].sheets.map((sheet) => sheet.include),
      [true, false]
    );
  } finally {
    unmount();
  }
});

test("excluding every sheet disables create rather than making an empty batch", async () => {
  const submitted: ConfirmImportBody[] = [];
  const { container, unmount } = await renderDom(
    <ImportMappingPreview
      data={{ import: staged(), preview: [preview()] }}
      onConfirm={(body) => submitted.push(body)}
      onDiscard={() => {}}
    />
  );
  try {
    await click(findByLabel(container, "Include Security"));
    await click(confirmButton(container));
    assert.deepEqual(submitted, []);
  } finally {
    unmount();
  }
});

test("unclassified rows are listed with their reason and can be promoted", async () => {
  const submitted: ConfirmImportBody[] = [];
  const { container, unmount } = await renderDom(
    <ImportMappingPreview
      data={{ import: staged(), preview: [preview()] }}
      onConfirm={(body) => submitted.push(body)}
      onDiscard={() => {}}
    />
  );
  try {
    // The count and the row text are both visible: a bare "1 row skipped" would
    // make the gate a rubber stamp.
    assert.match(container.textContent ?? "", /1 rows not taken as questions/);
    assert.match(container.textContent ?? "", /Reviewed by legal/);
    assert.match(container.textContent ?? "", /blank_question/);

    await click(findByLabel(container, "Promote row 4 of Security"));
    await click(confirmButton(container));
    assert.deepEqual(submitted[0].promoted, ["0:3"]);
  } finally {
    unmount();
  }
});

test("a failed import explains itself and still offers a hand mapping", async () => {
  const { container, unmount } = await renderDom(
    <ImportMappingPreview
      data={{
        import: staged({ status: "failed", error: "could not start the column mapping", mapping: undefined as never }),
        preview: [preview({ questionCount: 0, sampleRows: [] })]
      }}
      onConfirm={() => {}}
      onDiscard={() => {}}
    />
  );
  try {
    assert.match(container.textContent ?? "", /could not start the column mapping/);
    // Never a dead end: the column selects are still there to be filled in.
    assert.ok(container.querySelector('[aria-label="Security · Question column"]'));
  } finally {
    unmount();
  }
});

test("discarding the upload calls back", async () => {
  let discarded = 0;
  const { container, unmount } = await renderDom(
    <ImportMappingPreview
      data={{ import: staged(), preview: [preview()] }}
      onConfirm={() => {}}
      onDiscard={() => {
        discarded += 1;
      }}
    />
  );
  try {
    const button = [...container.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes("Discard upload")
    );
    assert.ok(button);
    await click(button);
    assert.equal(discarded, 1);
  } finally {
    unmount();
  }
});
