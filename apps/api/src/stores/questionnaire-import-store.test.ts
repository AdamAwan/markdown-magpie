import test from "node:test";
import assert from "node:assert/strict";
import type { SheetGrid, SheetMapping } from "@magpie/core";
import { InMemoryQuestionnaireImportStore } from "./questionnaire-import-store.js";

const grid: SheetGrid[] = [
  {
    name: "Sheet1",
    rows: [
      ["Question", "Answer"],
      ["Do you encrypt?", "Yes, AES-256."]
    ]
  }
];

const mapping: SheetMapping[] = [
  {
    sheetIndex: 0,
    role: "questions",
    headerRow: 0,
    questionColumn: 0,
    answerColumn: 1,
    responseTypeColumn: null,
    sectionHeadingColumn: null,
    confidence: "high",
    reason: "header row names Question and Answer"
  }
];

function createInput() {
  return { flowId: "default", name: "Acme SIG", filename: "acme.xlsx", format: "xlsx" as const, sheets: grid };
}

test("a new import starts in mapping and keeps its grid", async () => {
  const store = new InMemoryQuestionnaireImportStore();
  const created = await store.create(createInput());
  assert.equal(created.status, "mapping");
  assert.deepEqual(await store.sheets(created.id), grid);
});

test("the mapping proposal lands on the row and is findable by job id", async () => {
  const store = new InMemoryQuestionnaireImportStore();
  const created = await store.create(createInput());
  await store.attachJob(created.id, "job-1");
  await store.markMapped(created.id, mapping);
  const found = await store.byJobId("job-1");
  assert.equal(found?.status, "mapped");
  assert.deepEqual(found?.mapping, mapping);
});

test("a failed mapping keeps the grid so it stays recoverable without a re-upload", async () => {
  const store = new InMemoryQuestionnaireImportStore();
  const created = await store.create(createInput());
  await store.markFailed(created.id, "provider unavailable");
  const row = await store.get(created.id);
  assert.equal(row?.status, "failed");
  assert.equal(row?.error, "provider unavailable");
  assert.deepEqual(await store.sheets(created.id), grid);
});

test("confirm drops the grid but keeps the audit trail", async () => {
  const store = new InMemoryQuestionnaireImportStore();
  const created = await store.create(createInput());
  await store.confirm(created.id, { questionnaireId: "q1", mapping });
  const row = await store.get(created.id);
  assert.equal(row?.status, "confirmed");
  assert.equal(row?.questionnaireId, "q1");
  assert.equal(row?.filename, "acme.xlsx");
  assert.deepEqual(row?.mapping, mapping);
  assert.equal(await store.sheets(created.id), undefined);
});

test("the sweep deletes only unconfirmed imports older than the cutoff", async () => {
  const store = new InMemoryQuestionnaireImportStore();
  const stale = await store.create(createInput());
  const fresh = await store.create(createInput());
  const staleConfirmed = await store.create(createInput());
  const old = new Date(Date.now() - 48 * 3600_000).toISOString();
  store.setCreatedAtForTest(stale.id, old);
  store.setCreatedAtForTest(staleConfirmed.id, old);
  await store.confirm(staleConfirmed.id, { questionnaireId: "q2", mapping });

  const deleted = await store.sweep(new Date(Date.now() - 24 * 3600_000).toISOString());

  assert.equal(deleted, 1);
  assert.equal(await store.get(stale.id), undefined);
  assert.ok(await store.get(fresh.id));
  assert.ok(await store.get(staleConfirmed.id));
});
