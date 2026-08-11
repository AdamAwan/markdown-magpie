import type { ImportPreviewRow, ImportSheetPreview, SheetGrid, SheetMapping } from "@magpie/core";

// Turning a grid plus a mapping into questions. Pure, deterministic, and shared
// by BOTH the preview the operator confirms against and the confirm path that
// creates the questionnaire — which is what makes "what was approved is what
// gets created" true rather than aspirational (docs/questionnaires.md Q33).

export const PREVIEW_SAMPLE_ROWS = 8;
export const PREVIEW_UNCLASSIFIED_ROWS = 50;
export const PREVIEW_HEADER_ROWS = 5;

export interface ApplyMappingOptions {
  // Rows the operator promoted out of the unclassified list, as "sheetIndex:rowIndex".
  promoted?: readonly string[];
  // Sheets the operator excluded, by index. A sheet contributes when its mapping
  // role is "questions" and it is not listed here.
  excluded?: readonly number[];
}

export interface AppliedMapping {
  questions: Array<{ question: string; importedAnswer?: string }>;
  sheets: ImportSheetPreview[];
}

export function promotedKey(sheetIndex: number, rowIndex: number): string {
  return `${sheetIndex}:${rowIndex}`;
}

function cell(row: readonly string[], column: number | null): string {
  if (column === null) {
    return "";
  }
  return (row[column] ?? "").trim();
}

function isBlankRow(row: readonly string[]): boolean {
  return row.every((value) => value.trim().length === 0);
}

// The question text as it will be created: the sheet name when more than one
// sheet contributes (a workbook's tabs are its top-level sections), then the
// running section heading. Both prefixes exist because a question like "Do you?"
// is meaningless once lifted out of the sheet and section that framed it.
function decorate(
  question: string,
  sheetName: string,
  sectionHeading: string | undefined,
  prefixSheet: boolean
): string {
  const withSection = sectionHeading ? `${sectionHeading}: ${question}` : question;
  return prefixSheet ? `${sheetName} — ${withSection}` : withSection;
}

function classifySheet(
  sheet: SheetGrid,
  mapping: SheetMapping,
  sheetIndex: number,
  promoted: ReadonlySet<string>,
  prefixSheet: boolean
): { rows: ImportPreviewRow[]; questions: Array<{ question: string; importedAnswer?: string }> } {
  const rows: ImportPreviewRow[] = [];
  const questions: Array<{ question: string; importedAnswer?: string }> = [];
  let sectionHeading: string | undefined;

  for (const [rowIndex, row] of sheet.rows.entries()) {
    const question = cell(row, mapping.questionColumn);
    const answer = cell(row, mapping.answerColumn);
    const heading = cell(row, mapping.sectionHeadingColumn);
    const isPromoted = promoted.has(promotedKey(sheetIndex, rowIndex));

    // A promoted row is a human overriding every rule below, so it comes first.
    // Without a mapped question column it falls back to the row's first
    // non-empty cell, which is the only sane reading of "make this a question".
    if (isPromoted) {
      const text = question || row.map((value) => value.trim()).find((value) => value.length > 0) || "";
      if (text) {
        const entry = {
          question: decorate(text, sheet.name, sectionHeading, prefixSheet),
          ...(answer ? { importedAnswer: answer } : {})
        };
        questions.push(entry);
        rows.push({
          sheetIndex,
          rowIndex,
          kind: "question",
          question: entry.question,
          ...(answer ? { importedAnswer: answer } : {}),
          ...(sectionHeading ? { sectionHeading } : {})
        });
        continue;
      }
    }

    if (mapping.headerRow !== null && rowIndex <= mapping.headerRow) {
      rows.push({
        sheetIndex,
        rowIndex,
        kind: "unclassified",
        question: row.join(" · ").trim(),
        reason: "above_header"
      });
      continue;
    }
    if (mapping.questionColumn === null) {
      if (!isBlankRow(row)) {
        rows.push({
          sheetIndex,
          rowIndex,
          kind: "unclassified",
          question: row.join(" · ").trim(),
          reason: "no_mapping"
        });
      }
      continue;
    }
    // A section heading: the heading column speaks and the question column does
    // not. It becomes the running section for the questions beneath it.
    if (!question && heading && mapping.sectionHeadingColumn !== mapping.questionColumn) {
      sectionHeading = heading;
      rows.push({ sheetIndex, rowIndex, kind: "heading", question: heading, sectionHeading: heading });
      continue;
    }
    if (question) {
      // A "question" row with nothing anywhere else, in a sheet whose heading
      // column IS the question column, is the classic in-line section banner.
      if (
        mapping.sectionHeadingColumn === mapping.questionColumn &&
        !answer &&
        isBlankRow(row.filter((_, index) => index !== mapping.questionColumn))
      ) {
        sectionHeading = question;
        rows.push({ sheetIndex, rowIndex, kind: "heading", question, sectionHeading: question });
        continue;
      }
      const entry = {
        question: decorate(question, sheet.name, sectionHeading, prefixSheet),
        ...(answer ? { importedAnswer: answer } : {})
      };
      questions.push(entry);
      rows.push({
        sheetIndex,
        rowIndex,
        kind: "question",
        question: entry.question,
        ...(answer ? { importedAnswer: answer } : {}),
        ...(sectionHeading ? { sectionHeading } : {})
      });
      continue;
    }
    // Blank rows are noise and stay silent; a row with text somewhere but not in
    // the question column is exactly the row a wrong mapping loses, so it is
    // surfaced for triage rather than dropped.
    if (!isBlankRow(row)) {
      rows.push({
        sheetIndex,
        rowIndex,
        kind: "unclassified",
        question: row.join(" · ").trim(),
        reason: "blank_question"
      });
    }
  }

  return { rows, questions };
}

export function applyMapping(
  sheets: readonly SheetGrid[],
  mapping: readonly SheetMapping[],
  options: ApplyMappingOptions = {}
): AppliedMapping {
  const promoted = new Set(options.promoted ?? []);
  const excluded = new Set(options.excluded ?? []);
  const includes = (index: number): boolean =>
    !excluded.has(index) && (mapping.find((entry) => entry.sheetIndex === index)?.role ?? "ignore") === "questions";
  const prefixSheet = sheets.filter((_, index) => includes(index)).length > 1;

  const questions: Array<{ question: string; importedAnswer?: string }> = [];
  const previews: ImportSheetPreview[] = [];

  for (const [sheetIndex, sheet] of sheets.entries()) {
    const sheetMapping = mapping.find((entry) => entry.sheetIndex === sheetIndex);
    const columnCount = sheet.rows.reduce((widest, row) => Math.max(widest, row.length), 0);
    const headerSample = sheet.rows.slice(0, PREVIEW_HEADER_ROWS).map((row) => [...row]);
    if (!sheetMapping || !includes(sheetIndex)) {
      previews.push({
        sheetIndex,
        name: sheet.name,
        rowCount: sheet.rows.length,
        columnCount,
        questionCount: 0,
        unclassifiedCount: 0,
        sampleRows: [],
        unclassifiedRows: [],
        headerSample
      });
      continue;
    }
    const classified = classifySheet(sheet, sheetMapping, sheetIndex, promoted, prefixSheet);
    questions.push(...classified.questions);
    const unclassified = classified.rows.filter((row) => row.kind === "unclassified");
    previews.push({
      sheetIndex,
      name: sheet.name,
      rowCount: sheet.rows.length,
      columnCount,
      questionCount: classified.questions.length,
      unclassifiedCount: unclassified.length,
      // Bounded: a 5000-row sheet must not become a 5000-row HTTP response.
      sampleRows: classified.rows.filter((row) => row.kind !== "unclassified").slice(0, PREVIEW_SAMPLE_ROWS),
      unclassifiedRows: unclassified.slice(0, PREVIEW_UNCLASSIFIED_ROWS),
      headerSample
    });
  }

  return { questions, sheets: previews };
}
