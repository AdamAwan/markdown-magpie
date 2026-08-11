import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "./parse-csv.js";

test("parses quoted fields carrying the delimiter and a newline", () => {
  const rows = parseCsv('Question,Answer\r\n"Do you, encrypt?","Yes.\nAES-256."\r\n');
  assert.deepEqual(rows, [
    ["Question", "Answer"],
    ["Do you, encrypt?", "Yes.\nAES-256."]
  ]);
});

test("a doubled quote inside a quoted field collapses to one", () => {
  assert.deepEqual(parseCsv('a,"say ""hi"""'), [["a", 'say "hi"']]);
});

test("strips a UTF-8 BOM so the first header is not mangled", () => {
  assert.deepEqual(parseCsv("﻿Question,Answer"), [["Question", "Answer"]]);
});

test("sniffs a semicolon delimiter", () => {
  assert.deepEqual(parseCsv("Question;Answer\nDo you?;Yes"), [
    ["Question", "Answer"],
    ["Do you?", "Yes"]
  ]);
});

test("sniffs a tab delimiter", () => {
  assert.deepEqual(parseCsv("Question\tAnswer"), [["Question", "Answer"]]);
});

test("a comma inside quotes does not outvote the real delimiter", () => {
  assert.deepEqual(parseCsv('"Do you, encrypt?";Yes'), [["Do you, encrypt?", "Yes"]]);
});

test("blank trailing lines do not become rows", () => {
  assert.deepEqual(parseCsv("a,b\n"), [["a", "b"]]);
});

test("an empty cell is preserved, not dropped", () => {
  assert.deepEqual(parseCsv("Do you encrypt?,,Yes/No"), [["Do you encrypt?", "", "Yes/No"]]);
});
