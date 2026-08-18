import type { ImportSheetPreview, Questionnaire, QuestionnaireImport, SheetGrid, SheetMapping } from "@magpie/core";
import type { AppContext } from "../../context.js";
import { logger } from "../../logger.js";
import { nonInteractiveAiCapacity } from "../../platform/ai-capacity.js";
import { createQuestionnaire } from "../questionnaires/service.js";
import { applyMapping } from "./apply-mapping.js";
import { parseWorkbook, type ParseFailure } from "./parse.js";

// Uploading a questionnaire file (docs/questionnaires.md Q29+). An upload is a
// STAGING resource: it creates a questionnaire_imports row, never a
// questionnaire, and only `confirm` calls the ordinary create service. Nothing
// downstream of that call knows a file was involved.

// How much of each sheet the mapping model sees. Bounded for cost and for blast
// radius: the model needs enough rows to recognise a layout, not the customer's
// whole questionnaire.
export const SAMPLE_ROWS = 30;
const SAMPLE_COLUMNS = 25;
const SAMPLE_CELL_CHARS = 200;

// Unconfirmed uploads are customer material with no owner, so they expire.
const IMPORT_TTL_MS = 24 * 60 * 60 * 1000;

// The questionnaire create schema's own bound, enforced here so an operator is
// told at the gate rather than by a 400 from the create route.
const MAX_QUESTIONS = 500;

export type UploadResult =
  { ok: true; import: QuestionnaireImport } | { ok: false; code: ParseFailure | "flow_not_found" };

export type ConfirmResult =
  | { ok: true; questionnaire: Questionnaire }
  | { ok: false; code: "not_found" | "not_mapped" | "empty_questionnaire" | "too_many_questions" };

export interface ImportView {
  import: QuestionnaireImport;
  preview: ImportSheetPreview[];
}

function sample(sheets: readonly SheetGrid[]): Array<{
  index: number;
  name: string;
  rowCount: number;
  sampleRows: string[][];
}> {
  return sheets.map((sheet, index) => ({
    index,
    name: sheet.name,
    // The sheet's TRUE length travels with the sample so the model can tell a
    // 12-row cover sheet from a 900-row domain tab it is only seeing the top of.
    rowCount: sheet.rows.length,
    sampleRows: sheet.rows
      .slice(0, SAMPLE_ROWS)
      .map((row) =>
        row
          .slice(0, SAMPLE_COLUMNS)
          .map((cell) => (cell.length > SAMPLE_CELL_CHARS ? `${cell.slice(0, SAMPLE_CELL_CHARS)}…` : cell))
      )
  }));
}

// Derived-state hygiene, in the manner of the drip: the sweep runs on the way
// past rather than on a timer, so a restart can never strand a stale upload.
export async function sweepQuestionnaireImports(ctx: AppContext): Promise<void> {
  const deleted = await ctx.stores.questionnaireImports.sweep(new Date(Date.now() - IMPORT_TTL_MS).toISOString());
  if (deleted > 0) {
    logger.info({ deleted }, "swept unconfirmed questionnaire imports past their 24h retention");
  }
}

export async function uploadQuestionnaireImport(
  ctx: AppContext,
  input: { flowId: string; name: string; filename: string; bytes: Uint8Array }
): Promise<UploadResult> {
  if (!ctx.knowledgeConfig.flows.some((flow) => flow.id === input.flowId)) {
    return { ok: false, code: "flow_not_found" };
  }
  // Parsed here, in the request. The bytes are never written anywhere: only the
  // extracted grid below is persisted, and it goes on confirm (Q32).
  const parsed = parseWorkbook(input.filename, input.bytes);
  if (!parsed.ok) {
    return { ok: false, code: parsed.code };
  }
  await sweepQuestionnaireImports(ctx);

  const created = await ctx.stores.questionnaireImports.create({
    flowId: input.flowId,
    name: input.name,
    filename: input.filename,
    format: parsed.format,
    sheets: parsed.sheets
  });

  const jobInput = {
    provider: ctx.config.get().aiProvider,
    importId: created.id,
    sheets: sample(parsed.sheets),
    flowId: input.flowId,
    expectedOutput: "column_mapping" as const
  };
  try {
    // Metered but not interactive, admitted through the same stricter gate the
    // questionnaire drip uses so a mapping can never eat the reserve protecting
    // live /api/ask.
    const capacity = nonInteractiveAiCapacity(ctx);
    const admission = capacity
      ? await ctx.jobs.createIfAdmitted("map_questionnaire_columns", jobInput, capacity)
      : { admitted: true, job: await ctx.jobs.create("map_questionnaire_columns", jobInput) };
    if (admission.admitted && admission.job) {
      await ctx.stores.questionnaireImports.attachJob(created.id, admission.job.id);
    } else {
      await ctx.stores.questionnaireImports.markFailed(created.id, "AI capacity exhausted; retry the mapping shortly");
    }
  } catch (error) {
    // Never a dead end (Q34): the grid is stored, so the operator can map the
    // sheet by hand from the preview even when no mapping job ever ran.
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ importId: created.id, err: message }, "failed to enqueue the column-mapping job");
    await ctx.stores.questionnaireImports.markFailed(created.id, "could not start the column mapping");
  }

  const stored = await ctx.stores.questionnaireImports.get(created.id);
  return { ok: true, import: stored ?? created };
}

// The job's completion side effect. Without it the mapping runs and vanishes,
// and the operator polls a "mapping" import forever.
export async function applyColumnMapping(
  ctx: AppContext,
  jobId: string,
  output: { sheets: SheetMapping[] }
): Promise<void> {
  const found = await ctx.stores.questionnaireImports.byJobId(jobId);
  if (!found || found.status === "confirmed") {
    return;
  }
  await ctx.stores.questionnaireImports.markMapped(found.id, output.sheets);
}

// The job's TERMINAL-failure side effect, the twin of applyColumnMapping above
// (#366). Without it a dead-lettered mapping job leaves the import in `mapping`
// forever with the reason visible only in the logs and the dead-letter queue,
// and the operator watches a spinner that never resolves — while Q36 of
// docs/questionnaires.md promises exactly this terminal state. The grid
// deliberately survives (markFailed keeps it), so the operator maps by hand.
export async function handleColumnMappingFailure(ctx: AppContext, jobId: string, message: string): Promise<void> {
  const found = await ctx.stores.questionnaireImports.byJobId(jobId);
  // Only a still-mapping import is failed: a mapping that already landed, or an
  // import already confirmed or failed, must never be regressed by a late failure.
  if (!found || found.status !== "mapping") {
    return;
  }
  await ctx.stores.questionnaireImports.markFailed(found.id, mappingFailureReason(message));
}

// The stored reason reads as a sentence fragment, because the console renders it
// as "<reason>. Map the columns by hand below…".
function mappingFailureReason(message: string): string {
  const detail = message.trim().replace(/[.\s]+$/, "");
  return detail ? `the automatic column mapping failed: ${detail}` : "the automatic column mapping failed";
}

export async function getQuestionnaireImport(ctx: AppContext, id: string): Promise<ImportView | undefined> {
  const found = await ctx.stores.questionnaireImports.get(id);
  if (!found) {
    return undefined;
  }
  const sheets = await ctx.stores.questionnaireImports.sheets(id);
  if (!sheets) {
    // Confirmed (or swept mid-read): the grid is gone by design, and the row
    // survives only as the audit trail.
    return { import: found, preview: [] };
  }
  // The preview is built by the SAME function confirm uses, so what the operator
  // approves is what gets created.
  return { import: found, preview: applyMapping(sheets, found.mapping ?? fallbackMapping(sheets)).sheets };
}

// What the operator is shown when no mapping proposal exists — a failed job, or
// one that classified nothing. Every sheet included with nothing mapped, so the
// preview renders and every column select starts blank rather than 404-ing.
function fallbackMapping(sheets: readonly SheetGrid[]): SheetMapping[] {
  return sheets.map((_, sheetIndex) => ({
    sheetIndex,
    role: "questions",
    headerRow: null,
    questionColumn: null,
    answerColumn: null,
    responseTypeColumn: null,
    sectionHeadingColumn: null,
    confidence: "low",
    reason: "no mapping was proposed; pick the columns by hand"
  }));
}

export async function confirmQuestionnaireImport(
  ctx: AppContext,
  id: string,
  input: {
    sheets: Array<{ sheetIndex: number; include: boolean; mapping: SheetMapping }>;
    promoted?: string[];
  }
): Promise<ConfirmResult> {
  const found = await ctx.stores.questionnaireImports.get(id);
  if (!found) {
    return { ok: false, code: "not_found" };
  }
  const sheets = await ctx.stores.questionnaireImports.sheets(id);
  if (!sheets) {
    // Already confirmed, or swept: there is nothing left to create from.
    return { ok: false, code: "not_mapped" };
  }
  const mapping = input.sheets.map((sheet) => sheet.mapping);
  const excluded = input.sheets.filter((sheet) => !sheet.include).map((sheet) => sheet.sheetIndex);
  const applied = applyMapping(sheets, mapping, {
    excluded,
    ...(input.promoted ? { promoted: input.promoted } : {})
  });
  if (applied.questions.length === 0) {
    return { ok: false, code: "empty_questionnaire" };
  }
  if (applied.questions.length > MAX_QUESTIONS) {
    return { ok: false, code: "too_many_questions" };
  }

  const outcome = await createQuestionnaire(ctx, {
    name: found.name,
    flowId: found.flowId,
    questions: applied.questions,
    // The file's name is where this batch came from, and its presence is the
    // single switch onto the adjudication path (Q19).
    importOrigin: found.filename
  });
  if (!outcome.ok) {
    return { ok: false, code: outcome.code === "flow_not_found" ? "not_found" : "empty_questionnaire" };
  }
  await ctx.stores.questionnaireImports.confirm(id, { questionnaireId: outcome.questionnaire.id, mapping });
  logger.info(
    { importId: id, questionnaireId: outcome.questionnaire.id, questions: applied.questions.length },
    "confirmed a questionnaire import; the extracted grid has been dropped"
  );
  return { ok: true, questionnaire: outcome.questionnaire };
}

export async function discardQuestionnaireImport(ctx: AppContext, id: string): Promise<void> {
  await ctx.stores.questionnaireImports.remove(id);
}
