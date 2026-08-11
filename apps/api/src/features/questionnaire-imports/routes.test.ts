import { test } from "node:test";
import assert from "node:assert/strict";
import type { ImportSheetPreview, Questionnaire, QuestionnaireImport, SheetMapping } from "@magpie/core";
import { buildApp } from "../../app.js";
import { makeTestContext } from "../../test-support/context.js";
import { applyColumnMapping } from "./service.js";

// Auth is disabled in the test context, so requireScopes is a pass-through and
// these exercise the endpoints' shape directly (the questionnaire routes model).

function flowContext() {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [{ id: "security", name: "Security", sourceIds: [], destinationId: "kb" }];
  return ctx;
}

const mapping: SheetMapping = {
  sheetIndex: 0,
  role: "questions",
  headerRow: 0,
  questionColumn: 0,
  answerColumn: 1,
  responseTypeColumn: null,
  sectionHeadingColumn: null,
  confidence: "high",
  reason: "header row names Question and Answer"
};

function uploadForm(filename = "acme.csv", body = "Question,Answer\nDo you encrypt?,Yes."): FormData {
  const form = new FormData();
  form.set("file", new File([body], filename, { type: "text/csv" }));
  form.set("flowId", "security");
  form.set("name", "Acme SIG");
  return form;
}

function upload(app: ReturnType<typeof buildApp>, form: FormData) {
  return app.request("/api/questionnaire-imports", { method: "POST", body: form });
}

test("POST /api/questionnaire-imports stages the upload and returns 202", async () => {
  const ctx = flowContext();
  const app = buildApp(ctx);
  const res = await upload(app, uploadForm());
  assert.equal(res.status, 202);
  const body = (await res.json()) as { import: QuestionnaireImport };
  assert.equal(body.import.status, "mapping");
  assert.equal(body.import.filename, "acme.csv");
});

test("POST rejects a body with no file, an unknown flow, and an unreadable file", async () => {
  const ctx = flowContext();
  const app = buildApp(ctx);

  const noFile = new FormData();
  noFile.set("flowId", "security");
  noFile.set("name", "Acme");
  assert.equal((await upload(app, noFile)).status, 400);

  const unknownFlow = uploadForm();
  unknownFlow.set("flowId", "nope");
  assert.equal((await upload(app, unknownFlow)).status, 404);

  const unsupported = await upload(app, uploadForm("acme.docx"));
  assert.equal(unsupported.status, 400);
  assert.deepEqual(await unsupported.json(), { error: "unsupported_format" });
});

test("GET /api/questionnaire-imports/:id returns the mapping and the preview", async () => {
  const ctx = flowContext();
  const app = buildApp(ctx);
  const created = (await (await upload(app, uploadForm())).json()) as { import: QuestionnaireImport };
  await applyColumnMapping(ctx, created.import.jobId ?? "", { sheets: [mapping] });

  const res = await app.request(`/api/questionnaire-imports/${created.import.id}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { import: QuestionnaireImport; preview: ImportSheetPreview[] };
  assert.equal(body.import.status, "mapped");
  assert.equal(body.preview[0].questionCount, 1);
  assert.equal(body.preview[0].sampleRows[0].question, "Do you encrypt?");
});

test("GET 404s an unknown import", async () => {
  const app = buildApp(flowContext());
  assert.equal((await app.request("/api/questionnaire-imports/nope")).status, 404);
});

test("POST /:id/confirm creates the questionnaire and 400s a malformed body", async () => {
  const ctx = flowContext();
  const app = buildApp(ctx);
  const created = (await (await upload(app, uploadForm())).json()) as { import: QuestionnaireImport };

  const malformed = await app.request(`/api/questionnaire-imports/${created.import.id}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sheets: [{ sheetIndex: 0, include: true, mapping: { role: "questions" } }] })
  });
  assert.equal(malformed.status, 400);

  const res = await app.request(`/api/questionnaire-imports/${created.import.id}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sheets: [{ sheetIndex: 0, include: true, mapping }] })
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { questionnaire: Questionnaire };
  assert.equal(body.questionnaire.importOrigin, "acme.csv");
  assert.equal(body.questionnaire.items[0].importedAnswer, "Yes.");
});

test("confirming an upload with nothing selected is a 409, not a silent empty batch", async () => {
  const ctx = flowContext();
  const app = buildApp(ctx);
  const created = (await (await upload(app, uploadForm())).json()) as { import: QuestionnaireImport };
  const res = await app.request(`/api/questionnaire-imports/${created.import.id}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sheets: [{ sheetIndex: 0, include: false, mapping }] })
  });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "empty_questionnaire" });
});

test("DELETE discards the upload, taking the extracted grid with it", async () => {
  const ctx = flowContext();
  const app = buildApp(ctx);
  const created = (await (await upload(app, uploadForm())).json()) as { import: QuestionnaireImport };

  const res = await app.request(`/api/questionnaire-imports/${created.import.id}`, { method: "DELETE" });

  assert.equal(res.status, 200);
  assert.equal(await ctx.stores.questionnaireImports.get(created.import.id), undefined);
  assert.equal(await ctx.stores.questionnaireImports.sheets(created.import.id), undefined);
});
