import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { strToU8, zipSync, type Zippable } from "fflate";
import { MAX_XLSX_ENTRIES, MAX_XLSX_ENTRY_BYTES, MAX_XLSX_TOTAL_BYTES } from "./parse-xlsx.js";
import { parseWorkbook } from "./parse.js";

// docs/questionnaires.md Q37: the xlsx reader inflates under hard bounds, so a
// small archive that expands enormously (a zip bomb) is refused while it is being
// decompressed, never after.

const sample = new Uint8Array(readFileSync(new URL("./fixtures/sample.xlsx", import.meta.url)));

// The minimal parts a readable one-sheet workbook needs.
const workbookParts: Zippable = {
  "xl/workbook.xml": strToU8(
    '<workbook xmlns:r="r"><sheets><sheet name="Q" sheetId="1" r:id="rId1"/></sheets></workbook>'
  ),
  "xl/_rels/workbook.xml.rels": strToU8(
    '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'
  ),
  "xl/worksheets/sheet1.xml": strToU8(
    '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Do you use MFA?</t></is></c></row></sheetData></worksheet>'
  )
};

// Highly compressible filler: a few KB on the wire, megabytes once inflated.
function zeros(bytes: number): Uint8Array {
  return new Uint8Array(bytes);
}

test("a workbook within the bounds still parses", () => {
  const result = parseWorkbook("ok.xlsx", zipSync(workbookParts, { level: 9 }));
  assert.ok(result.ok);
  assert.deepEqual(result.sheets[0]?.rows, [["Do you use MFA?"]]);
  assert.ok(parseWorkbook("acme.xlsx", sample).ok, "the reference fixture is unaffected");
});

test("a single part that inflates past the per-entry bound is workbook_too_large", () => {
  const bomb = zipSync({ ...workbookParts, "xl/sharedStrings.xml": zeros(MAX_XLSX_ENTRY_BYTES + 1) }, { level: 9 });
  assert.ok(bomb.byteLength < 1024 * 1024, "the archive itself is small: it is the expansion that is refused");
  assert.deepEqual(parseWorkbook("bomb.xlsx", bomb), { ok: false, code: "workbook_too_large" });
});

test("parts that together inflate past the total bound are workbook_too_large", () => {
  const share = Math.floor(MAX_XLSX_TOTAL_BYTES / 3) + 1;
  const filler = zeros(share);
  const archive = zipSync(
    { ...workbookParts, "xl/a.xml": filler, "xl/b.xml": filler, "xl/c.xml": filler },
    { level: 9 }
  );
  assert.ok(share < MAX_XLSX_ENTRY_BYTES, "each part is individually within bounds");
  assert.deepEqual(parseWorkbook("bomb.xlsx", archive), { ok: false, code: "workbook_too_large" });
});

test("an archive with too many entries is workbook_too_large", () => {
  const parts: Zippable = { ...workbookParts };
  for (let index = 0; index <= MAX_XLSX_ENTRIES; index += 1) {
    parts[`docProps/extra-${index}.txt`] = strToU8("x");
  }
  assert.deepEqual(parseWorkbook("many.xlsx", zipSync(parts)), { ok: false, code: "workbook_too_large" });
});

test("parts the reader never walks (media, embeddings) are skipped without inflating", () => {
  const archive = zipSync({ ...workbookParts, "xl/media/image1.png": zeros(MAX_XLSX_ENTRY_BYTES + 1) }, { level: 9 });
  const result = parseWorkbook("image.xlsx", archive);
  assert.ok(result.ok, "a large image does not count against the bounds");
});

test("a truncated archive is unreadable, not parsed with a part missing", () => {
  const archive = zipSync(workbookParts, { level: 0 });
  // Cut inside the last local file's data, before the central directory.
  const truncated = archive.subarray(0, Math.floor(archive.byteLength * 0.6));
  const result = parseWorkbook("cut.xlsx", truncated);
  assert.equal(result.ok, false);
});
