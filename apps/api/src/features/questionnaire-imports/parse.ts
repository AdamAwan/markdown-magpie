import type { SheetGrid } from "@magpie/core";
import { parseCsv } from "./parse-csv.js";
import { parseXlsx } from "./parse-xlsx.js";

// Format detection and the bounds. The uploaded bytes never leave this module:
// they are parsed here, in the request, and dropped — only the extracted grid
// is ever persisted (docs/questionnaires.md Q32).

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_SHEETS = 20;
export const MAX_ROWS_PER_SHEET = 5000;
export const MAX_COLUMNS = 60;
// Matches the imported-answer cap the questionnaire create schema enforces
// (Q19), so a cell that survives here can never be rejected downstream.
export const MAX_CELL_CHARS = 20000;

export type ImportFormat = "xlsx" | "csv";

export type ParseFailure = "unsupported_format" | "file_too_large" | "unreadable_file" | "empty_file";

export type ParseResult = { ok: true; format: ImportFormat; sheets: SheetGrid[] } | { ok: false; code: ParseFailure };

export function detectFormat(filename: string): ImportFormat | undefined {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".xlsx")) return "xlsx";
  if (lower.endsWith(".csv")) return "csv";
  return undefined;
}

function isBlank(cell: string): boolean {
  return cell.trim().length === 0;
}

// Clamp to the documented bounds and drop the trailing emptiness spreadsheets
// are full of. Cells are TRUNCATED rather than rejected: one runaway cell should
// not cost the operator the whole upload.
function clamp(sheets: SheetGrid[]): SheetGrid[] {
  return sheets.slice(0, MAX_SHEETS).map((sheet) => {
    const rows = sheet.rows
      .slice(0, MAX_ROWS_PER_SHEET)
      .map((row) =>
        row.slice(0, MAX_COLUMNS).map((cell) => (cell.length > MAX_CELL_CHARS ? cell.slice(0, MAX_CELL_CHARS) : cell))
      );
    while (rows.length > 0 && rows[rows.length - 1].every(isBlank)) {
      rows.pop();
    }
    const width = rows.reduce((widest, row) => {
      let last = 0;
      for (const [index, cell] of row.entries()) {
        if (!isBlank(cell)) {
          last = index + 1;
        }
      }
      return Math.max(widest, last);
    }, 0);
    return { name: sheet.name, rows: rows.map((row) => row.slice(0, width)) };
  });
}

export function parseWorkbook(filename: string, bytes: Uint8Array): ParseResult {
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return { ok: false, code: "file_too_large" };
  }
  const format = detectFormat(filename);
  if (!format) {
    return { ok: false, code: "unsupported_format" };
  }
  let sheets: SheetGrid[];
  try {
    sheets =
      format === "csv" ? [{ name: filename, rows: parseCsv(new TextDecoder().decode(bytes)) }] : parseXlsx(bytes);
  } catch {
    // A corrupt archive, a truncated upload, or XML this reader cannot follow.
    // The operator gets a message and their file back; nothing is stored.
    return { ok: false, code: "unreadable_file" };
  }
  const clamped = clamp(sheets).filter((sheet) => sheet.rows.length > 0);
  if (clamped.length === 0) {
    return { ok: false, code: "empty_file" };
  }
  return { ok: true, format, sheets: clamped };
}
