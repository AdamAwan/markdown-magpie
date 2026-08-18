import { test } from "node:test";
import assert from "node:assert/strict";
import type { SheetMapping } from "@magpie/core";
import { mapQuestionnaireColumnsInputSchema } from "@magpie/jobs";
import { failJob } from "../jobs/service.js";
import { makeTestContext } from "../../test-support/context.js";
import {
  applyColumnMapping,
  confirmQuestionnaireImport,
  getQuestionnaireImport,
  SAMPLE_ROWS,
  sweepQuestionnaireImports,
  uploadQuestionnaireImport
} from "./service.js";

function flowContext() {
  const ctx = makeTestContext();
  ctx.knowledgeConfig.flows = [{ id: "security", name: "Security", sourceIds: [], destinationId: "kb" }];
  return ctx;
}

const csv = (text: string) => new TextEncoder().encode(text);

const SIMPLE = "Question,Answer\nDo you encrypt at rest?,Yes — AES-256.\nDo you hold ISO 27001?,Yes.";

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

async function uploadSimple(ctx: ReturnType<typeof flowContext>, body = SIMPLE, filename = "acme.csv") {
  const result = await uploadQuestionnaireImport(ctx, {
    flowId: "security",
    name: "Acme SIG",
    filename,
    bytes: csv(body)
  });
  assert.ok(result.ok);
  return result.import;
}

test("an upload parses, stores the grid and enqueues the mapping job", async () => {
  const ctx = flowContext();
  const created = await uploadSimple(ctx);
  assert.equal(created.status, "mapping");
  assert.equal(created.format, "csv");
  const { jobs } = await ctx.jobs.list({ type: "map_questionnaire_columns" });
  assert.equal(jobs.length, 1);
  assert.equal(created.jobId, jobs[0].id);
});

test("the enqueued job carries a bounded sample and the sheet's true size", async () => {
  const ctx = flowContext();
  const rows = ["Question,Answer", ...Array.from({ length: 300 }, (_, index) => `Q${index},A${index}`)].join("\n");
  await uploadSimple(ctx, rows);
  const { jobs } = await ctx.jobs.list({ type: "map_questionnaire_columns" });
  const input = mapQuestionnaireColumnsInputSchema.parse(jobs[0].input);
  assert.equal(input.sheets[0].sampleRows.length, SAMPLE_ROWS);
  assert.equal(input.sheets[0].rowCount, 301);
});

test("an unsupported file is rejected and nothing is staged", async () => {
  const ctx = flowContext();
  const result = await uploadQuestionnaireImport(ctx, {
    flowId: "security",
    name: "x",
    filename: "acme.docx",
    bytes: csv("anything")
  });
  assert.deepEqual(result, { ok: false, code: "unsupported_format" });
  const { jobs } = await ctx.jobs.list({ type: "map_questionnaire_columns" });
  assert.equal(jobs.length, 0);
});

test("an unknown flow is refused before the file is read", async () => {
  const ctx = flowContext();
  const result = await uploadQuestionnaireImport(ctx, {
    flowId: "nope",
    name: "x",
    filename: "acme.csv",
    bytes: csv(SIMPLE)
  });
  assert.deepEqual(result, { ok: false, code: "flow_not_found" });
});

test("applying the job output flips the import to mapped", async () => {
  const ctx = flowContext();
  const created = await uploadSimple(ctx);
  await applyColumnMapping(ctx, created.jobId ?? "", { sheets: [mapping] });
  const view = await getQuestionnaireImport(ctx, created.id);
  assert.equal(view?.import.status, "mapped");
  assert.deepEqual(view?.import.mapping, [mapping]);
  assert.equal(view?.preview[0].questionCount, 2);
});

test("a mapping for an unknown job is a no-op rather than a throw", async () => {
  const ctx = flowContext();
  await applyColumnMapping(ctx, "no-such-job", { sheets: [mapping] });
});

test("an import with no mapping still previews, so the operator can map by hand", async () => {
  const ctx = flowContext();
  const created = await uploadSimple(ctx);
  const view = await getQuestionnaireImport(ctx, created.id);
  // Nothing mapped yet: every row is triage, and no question is invented.
  assert.equal(view?.preview[0].questionCount, 0);
  assert.ok((view?.preview[0].unclassifiedCount ?? 0) > 0);
});

test("confirm creates an imported questionnaire and drops the grid", async () => {
  const ctx = flowContext();
  const created = await uploadSimple(ctx);
  await applyColumnMapping(ctx, created.jobId ?? "", { sheets: [mapping] });

  const outcome = await confirmQuestionnaireImport(ctx, created.id, {
    sheets: [{ sheetIndex: 0, include: true, mapping }]
  });

  assert.ok(outcome.ok);
  // The file's name is the importOrigin, which is what switches the
  // questionnaire onto the adjudication path.
  assert.equal(outcome.questionnaire.importOrigin, "acme.csv");
  assert.equal(outcome.questionnaire.items.length, 2);
  assert.equal(outcome.questionnaire.items[0].importedAnswer, "Yes — AES-256.");
  assert.equal(await ctx.stores.questionnaireImports.sheets(created.id), undefined);
  const stored = await ctx.stores.questionnaireImports.get(created.id);
  assert.equal(stored?.status, "confirmed");
  assert.equal(stored?.questionnaireId, outcome.questionnaire.id);
});

test("confirming with every sheet excluded is refused rather than creating an empty batch", async () => {
  const ctx = flowContext();
  const created = await uploadSimple(ctx);
  const outcome = await confirmQuestionnaireImport(ctx, created.id, {
    sheets: [{ sheetIndex: 0, include: false, mapping }]
  });
  assert.deepEqual(outcome, { ok: false, code: "empty_questionnaire" });
});

test("confirming past the 500-question cap is refused at the gate", async () => {
  const ctx = flowContext();
  const rows = ["Question,Answer", ...Array.from({ length: 501 }, (_, index) => `Q${index},A${index}`)].join("\n");
  const created = await uploadSimple(ctx, rows);
  const outcome = await confirmQuestionnaireImport(ctx, created.id, {
    sheets: [{ sheetIndex: 0, include: true, mapping }]
  });
  assert.deepEqual(outcome, { ok: false, code: "too_many_questions" });
});

test("confirming twice cannot create a second questionnaire from the same upload", async () => {
  const ctx = flowContext();
  const created = await uploadSimple(ctx);
  await confirmQuestionnaireImport(ctx, created.id, { sheets: [{ sheetIndex: 0, include: true, mapping }] });
  const again = await confirmQuestionnaireImport(ctx, created.id, {
    sheets: [{ sheetIndex: 0, include: true, mapping }]
  });
  assert.deepEqual(again, { ok: false, code: "not_mapped" });
});

test("the operator's edited mapping wins over the model's proposal", async () => {
  const ctx = flowContext();
  const created = await uploadSimple(ctx, "Ref,Question,Answer\n1,Do you encrypt?,Yes.");
  // The model reads the reference column as the question column...
  await applyColumnMapping(ctx, created.jobId ?? "", { sheets: [{ ...mapping, questionColumn: 0, answerColumn: 2 }] });
  // ...and the operator corrects it before anything is created.
  const outcome = await confirmQuestionnaireImport(ctx, created.id, {
    sheets: [{ sheetIndex: 0, include: true, mapping: { ...mapping, questionColumn: 1, answerColumn: 2 } }]
  });
  assert.ok(outcome.ok);
  assert.equal(outcome.questionnaire.items[0].question, "Do you encrypt?");
});

test("a promoted row is created as a question", async () => {
  const ctx = flowContext();
  const created = await uploadSimple(ctx, "Acme questionnaire 2026\nQuestion,Answer\nDo you encrypt?,Yes.");
  const outcome = await confirmQuestionnaireImport(ctx, created.id, {
    sheets: [{ sheetIndex: 0, include: true, mapping: { ...mapping, headerRow: 1 } }],
    promoted: ["0:0"]
  });
  assert.ok(outcome.ok);
  assert.deepEqual(
    outcome.questionnaire.items.map((item) => item.question),
    ["Acme questionnaire 2026", "Do you encrypt?"]
  );
});

test("the sweep drops unconfirmed uploads past their retention and keeps confirmed ones", async () => {
  const ctx = flowContext();
  const stale = await uploadSimple(ctx);
  const confirmed = await uploadSimple(ctx);
  await confirmQuestionnaireImport(ctx, confirmed.id, { sheets: [{ sheetIndex: 0, include: true, mapping }] });
  const store = ctx.stores.questionnaireImports;
  assert.ok("setCreatedAtForTest" in store);
  store.setCreatedAtForTest(stale.id, new Date(Date.now() - 48 * 3600_000).toISOString());
  store.setCreatedAtForTest(confirmed.id, new Date(Date.now() - 48 * 3600_000).toISOString());

  await sweepQuestionnaireImports(ctx);

  assert.equal(await store.get(stale.id), undefined);
  assert.ok(await store.get(confirmed.id));
});

// A mapping job that exhausts its retries and dead-letters must land its reason
// on the import (#366) — otherwise the import sits in `mapping` forever and the
// failure is visible only in the logs and the dead-letter queue.
async function exhaustMappingJob(ctx: ReturnType<typeof flowContext>, jobId: string, message: string) {
  const jobError = { code: "runner_failed", message, category: "external" as const, executor: "watcher" };
  let failed = await failJob(ctx, jobId, jobError);
  while (failed?.state !== "failed") {
    failed = await failJob(ctx, jobId, jobError);
  }
}

test("a dead-lettered mapping job fails the import with its reason, grid intact", async () => {
  const ctx = flowContext();
  const created = await uploadSimple(ctx);
  await exhaustMappingJob(ctx, created.jobId ?? "", "model returned no sheets");

  const view = await getQuestionnaireImport(ctx, created.id);
  assert.equal(view?.import.status, "failed");
  assert.equal(view?.import.error, "the automatic column mapping failed: model returned no sheets");
  // The grid survives a failed mapping, so the operator maps by hand rather than
  // re-uploading the file.
  assert.ok((view?.preview[0].unclassifiedCount ?? 0) > 0);
});

test("a retryable mapping failure leaves the import mapping — the job will run again", async () => {
  const ctx = flowContext();
  const created = await uploadSimple(ctx);
  const failed = await failJob(ctx, created.jobId ?? "", {
    code: "runner_failed",
    message: "transient blip",
    category: "external",
    executor: "watcher"
  });
  assert.notEqual(failed?.state, "failed");

  const view = await getQuestionnaireImport(ctx, created.id);
  assert.equal(view?.import.status, "mapping");
  assert.equal(view?.import.error, undefined);
});

test("a late mapping failure never regresses an import that already mapped", async () => {
  const ctx = flowContext();
  const created = await uploadSimple(ctx);
  await applyColumnMapping(ctx, created.jobId ?? "", { sheets: [mapping] });
  await exhaustMappingJob(ctx, created.jobId ?? "", "too late");

  const view = await getQuestionnaireImport(ctx, created.id);
  assert.equal(view?.import.status, "mapped");
  assert.equal(view?.import.error, undefined);
});
