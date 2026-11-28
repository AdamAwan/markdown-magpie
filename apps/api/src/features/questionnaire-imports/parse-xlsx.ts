import { strFromU8, Unzip, UnzipInflate } from "fflate";
import { XMLParser } from "fast-xml-parser";
import type { SheetGrid } from "@magpie/core";

// Read-only text extraction from an .xlsx workbook. An xlsx is a zip of XML
// parts, and all we want from it is "what does each cell say" — so this unzips
// (fflate) and walks two part types (fast-xml-parser) rather than taking a
// full-fat spreadsheet library that also writes, styles and charts.
//
// Everything comes back as a STRING. A spreadsheet's own cell type tells us
// nothing about whether the cell holds a question, and coercing would lose
// leading zeroes, dates and the "1.0" a response-type column depends on.

// fast-xml-parser collapses a single child element to the object itself and
// only produces an array for two or more. Every walk below goes through this so
// a one-row sheet is not silently a different shape from a two-row one.
function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

// Everything as strings: parseTagValue/parseAttributeValue off means "007" stays
// "007" rather than becoming 7.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false
});

interface TextNode {
  "#text"?: string;
}

interface RichTextRun extends TextNode {
  t?: string | TextNode;
}

interface SharedStringItem {
  t?: string | TextNode;
  r?: RichTextRun | RichTextRun[];
}

interface CellNode {
  "@_r"?: string;
  "@_t"?: string;
  v?: string | TextNode;
  is?: SharedStringItem;
}

interface RowNode {
  "@_r"?: string;
  c?: CellNode | CellNode[];
}

// A <t> may arrive as a bare string or, when it carries attributes such as
// xml:space="preserve", as a node with a #text child.
function textOf(value: string | TextNode | undefined): string {
  if (value === undefined) {
    return "";
  }
  return typeof value === "string" ? value : (value["#text"] ?? "");
}

// A shared string is either one <t> or a run of <r><t> fragments that
// concatenate — bold-in-the-middle text is one cell, not several.
function sharedStringText(item: SharedStringItem): string {
  const runs = asArray(item.r).map((run) => textOf(run.t));
  return runs.length > 0 ? runs.join("") : textOf(item.t);
}

// "C7" -> 2. Column letters, not position in the row: a sparse row omits its
// empty cells entirely, so reading positionally would shift every later column.
function columnIndex(reference: string): number | undefined {
  const letters = /^([A-Z]+)/.exec(reference.toUpperCase());
  if (!letters) {
    return undefined;
  }
  let index = 0;
  for (const char of letters[1]) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

// Decompression bounds (docs/questionnaires.md Q37). An upload is capped at 5 MB
// COMPRESSED, but deflate expands up to ~1000:1, so a crafted 5 MB archive could
// otherwise inflate to gigabytes in the request (a zip bomb). Real questionnaire
// workbooks are a few dozen parts and a few MB of XML; these caps sit far above
// that and far below what would hurt the API process.
export const MAX_XLSX_ENTRIES = 1000;
export const MAX_XLSX_ENTRY_BYTES = 32 * 1024 * 1024;
export const MAX_XLSX_TOTAL_BYTES = 64 * 1024 * 1024;
// The compressed bytes are fed to the inflater this many at a time, so no single
// inflate step can produce more than ~1000x this before the caps are checked.
const FEED_CHUNK_BYTES = 16 * 1024;

// Thrown when an archive exceeds a decompression bound; parse.ts reports it as
// `workbook_too_large` (413) rather than `unreadable_file`.
export class WorkbookTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbookTooLargeError";
  }
}

// Only the XML parts the reader walks are ever inflated; images, embedded
// objects, printer settings and the like are skipped without decompressing.
function isReadPart(name: string): boolean {
  return name.startsWith("xl/") && (name.endsWith(".xml") || name.endsWith(".rels"));
}

// Streaming, bounded unzip: counts entries, and the decompressed bytes of each
// read part and of the whole archive, as they are produced — aborting the moment
// any bound is crossed instead of after a bomb has already been expanded.
function unzipBounded(bytes: Uint8Array): Record<string, Uint8Array> {
  const entries: Record<string, Uint8Array> = {};
  // Read parts whose data began but never finished: a truncated upload. Reported
  // as unreadable rather than parsed with a part silently missing.
  const pending = new Set<string>();
  let entryCount = 0;
  let totalBytes = 0;
  const unzip = new Unzip((file) => {
    entryCount += 1;
    if (entryCount > MAX_XLSX_ENTRIES) {
      throw new WorkbookTooLargeError(`archive has more than ${MAX_XLSX_ENTRIES} entries`);
    }
    if (!isReadPart(file.name)) {
      return;
    }
    const chunks: Uint8Array[] = [];
    let entryBytes = 0;
    pending.add(file.name);
    file.ondata = (error, chunk, final) => {
      if (error) {
        throw error;
      }
      entryBytes += chunk.length;
      totalBytes += chunk.length;
      if (entryBytes > MAX_XLSX_ENTRY_BYTES) {
        throw new WorkbookTooLargeError(`${file.name} inflates past ${MAX_XLSX_ENTRY_BYTES} bytes`);
      }
      if (totalBytes > MAX_XLSX_TOTAL_BYTES) {
        throw new WorkbookTooLargeError(`archive inflates past ${MAX_XLSX_TOTAL_BYTES} bytes`);
      }
      chunks.push(chunk);
      if (final) {
        const joined = new Uint8Array(entryBytes);
        let offset = 0;
        for (const part of chunks) {
          joined.set(part, offset);
          offset += part.length;
        }
        entries[file.name] = joined;
        pending.delete(file.name);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < bytes.length; offset += FEED_CHUNK_BYTES) {
    const end = Math.min(offset + FEED_CHUNK_BYTES, bytes.length);
    unzip.push(bytes.subarray(offset, end), end === bytes.length);
  }
  if (pending.size > 0) {
    throw new Error(`truncated archive: ${[...pending].join(", ")} is incomplete`);
  }
  return entries;
}

function parsePart(entries: Record<string, Uint8Array>, path: string): unknown {
  const entry = entries[path];
  return entry ? parser.parse(strFromU8(entry)) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Walk `path` (e.g. ["workbook", "sheets", "sheet"]) through the parsed document,
// returning undefined the moment a level is missing or is not an object. Keeps
// every reader below free of optional-chaining chains and of casts.
function pick(document: unknown, path: readonly string[]): unknown {
  let current: unknown = document;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function stringAttribute(value: unknown, attribute: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const found = value[attribute];
  return typeof found === "string" ? found : undefined;
}

function readSharedStrings(entries: Record<string, Uint8Array>): string[] {
  const items = pick(parsePart(entries, "xl/sharedStrings.xml"), ["sst", "si"]);
  if (items === undefined) {
    return [];
  }
  return asArray(items).map((item) => (isRecord(item) ? sharedStringText(item) : ""));
}

// r:id -> part path, from the workbook's own relationships. Sheet part names are
// not guaranteed to be sheet1.xml in workbook order, so the ids are the only
// reliable route from "the third tab" to its XML.
function readRelationships(entries: Record<string, Uint8Array>): Map<string, string> {
  const map = new Map<string, string>();
  for (const relationship of asArray(
    pick(parsePart(entries, "xl/_rels/workbook.xml.rels"), ["Relationships", "Relationship"])
  )) {
    const id = stringAttribute(relationship, "@_Id");
    const target = stringAttribute(relationship, "@_Target");
    if (id && target) {
      map.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`);
    }
  }
  return map;
}

function readSheetRows(entries: Record<string, Uint8Array>, path: string, sharedStrings: string[]): string[][] {
  const sheetData = pick(parsePart(entries, path), ["worksheet", "sheetData", "row"]);
  const rows: string[][] = [];
  for (const rowNode of asArray(sheetData)) {
    if (!isRecord(rowNode)) {
      continue;
    }
    const row: RowNode = rowNode;
    const cells: string[] = [];
    for (const [position, cell] of asArray(row.c).entries()) {
      const reference = cell["@_r"];
      const index = reference ? (columnIndex(reference) ?? position) : position;
      const type = cell["@_t"];
      let text: string;
      if (type === "s") {
        const sharedIndex = Number.parseInt(textOf(cell.v), 10);
        text = Number.isNaN(sharedIndex) ? "" : (sharedStrings[sharedIndex] ?? "");
      } else if (type === "inlineStr") {
        text = cell.is ? sharedStringText(cell.is) : "";
      } else {
        // Numbers, booleans and formulas alike: take the cached <v> as text and
        // never evaluate anything.
        text = textOf(cell.v);
      }
      while (cells.length < index) {
        cells.push("");
      }
      cells[index] = text;
    }
    rows.push(cells);
  }
  return rows;
}

// Throws on anything it cannot read (a corrupt archive, a missing workbook
// part); parse.ts turns that into an `unreadable_file` result. Throws
// WorkbookTooLargeError when the archive breaks a decompression bound.
export function parseXlsx(bytes: Uint8Array): SheetGrid[] {
  const entries = unzipBounded(bytes);
  const sharedStrings = readSharedStrings(entries);
  const relationships = readRelationships(entries);
  const sheets: SheetGrid[] = [];
  for (const [position, sheet] of asArray(
    pick(parsePart(entries, "xl/workbook.xml"), ["workbook", "sheets", "sheet"])
  ).entries()) {
    const name = stringAttribute(sheet, "@_name") ?? `Sheet${position + 1}`;
    const relationshipId = stringAttribute(sheet, "@_r:id");
    const path =
      (relationshipId ? relationships.get(relationshipId) : undefined) ?? `xl/worksheets/sheet${position + 1}.xml`;
    if (!entries[path]) {
      continue;
    }
    sheets.push({ name, rows: readSheetRows(entries, path, sharedStrings) });
  }
  if (sheets.length === 0) {
    throw new Error("workbook contains no readable sheets");
  }
  return sheets;
}
