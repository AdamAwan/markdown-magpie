import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAX_UPLOAD_BYTES, parseWorkbook } from "./parse.js";

// A two-tab workbook built with fflate (see the fixture note in the docs code
// map): an Instructions tab, and a Security tab mixing shared strings, an inline
// string, a numeric cell and a sparse row.
const xlsx = new Uint8Array(readFileSync(new URL("./fixtures/sample.xlsx", import.meta.url)));

test("reads every sheet of a workbook, in workbook order", () => {
  const result = parseWorkbook("acme.xlsx", xlsx);
  assert.ok(result.ok);
  assert.deepEqual(
    result.sheets.map((sheet) => sheet.name),
    ["Instructions", "Security"]
  );
});

test("shared, inline and numeric cells all arrive as text", () => {
  const result = parseWorkbook("acme.xlsx", xlsx);
  assert.ok(result.ok);
  const security = result.sheets[1];
  assert.equal(security.rows[0][0], "Acme Corp security questionnaire");
  assert.deepEqual(security.rows[1], ["Question", "Response", "Type", "2026"]);
  assert.deepEqual(security.rows[3], ["Do you enforce MFA?", "Yes, for all staff.", "Yes/No"]);
});

test("a sparse row keeps its gap rather than shifting later columns left", () => {
  const result = parseWorkbook("acme.xlsx", xlsx);
  assert.ok(result.ok);
  // Row 5 has A and C filled, B omitted from the XML entirely.
  assert.deepEqual(result.sheets[1].rows[4], ["Do you encrypt data at rest?", "", "Yes/No"]);
});

test("a csv routes to the csv reader and becomes one sheet", () => {
  const result = parseWorkbook("acme.CSV", new TextEncoder().encode("Q,A\nx,y"));
  assert.ok(result.ok);
  assert.equal(result.format, "csv");
  assert.deepEqual(result.sheets, [
    {
      name: "acme.CSV",
      rows: [
        ["Q", "A"],
        ["x", "y"]
      ]
    }
  ]);
});

test("an unsupported extension is rejected before anything is read", () => {
  assert.deepEqual(parseWorkbook("acme.docx", xlsx), { ok: false, code: "unsupported_format" });
});

test("an oversized upload is rejected", () => {
  assert.deepEqual(parseWorkbook("acme.csv", new Uint8Array(MAX_UPLOAD_BYTES + 1)), {
    ok: false,
    code: "file_too_large"
  });
});

test("a corrupt workbook reports unreadable rather than throwing", () => {
  assert.deepEqual(parseWorkbook("acme.xlsx", new Uint8Array([1, 2, 3])), { ok: false, code: "unreadable_file" });
});

test("a file with no cells is empty, not a zero-question import", () => {
  assert.deepEqual(parseWorkbook("acme.csv", new TextEncoder().encode("\n\n")), { ok: false, code: "empty_file" });
});

test("trailing blank rows and columns are trimmed", () => {
  const result = parseWorkbook("acme.csv", new TextEncoder().encode("a,b,,\nc,d,,\n,,,\n"));
  assert.ok(result.ok);
  assert.deepEqual(result.sheets[0].rows, [
    ["a", "b"],
    ["c", "d"]
  ]);
});
