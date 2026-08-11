# Uploading a questionnaire file — XLSX/CSV extraction with AI column mapping — design

**Date:** 2026-08-11
**Status:** Proposed
**Builds on:** [Questionnaire ingestion](2026-08-11-questionnaire-ingestion-design.md)
(Spec A, shipped as PR #353 — [questionnaires.md Q19–Q28](../../questionnaires.md))

## Problem

Spec A reads a completed questionnaire and adjudicates every previously-given answer instead
of trusting it. It works, and today the only way to feed it is to paste two tab-separated
columns into a box.

Real questionnaires do not arrive as two clean columns. They arrive as workbooks: SIG, CAIQ,
VSA and a long tail of bespoke spreadsheets, with a cover sheet, an instructions tab, several
domain tabs, merged headers, a response-type column of drop-downs, and section headings
interleaved with the questions. Getting one of those into Magpie today means an operator
hand-shepherding a spreadsheet into a paste box, which is exactly the work the feature is
supposed to remove — and the point at which the pile of completed questionnaires stays a pile.

## Goal

Upload the file, and turn it into the pairs the Spec A pipeline already consumes. This spec
adds **a way to fill `POST /api/questionnaires`** with `{question, importedAnswer?}[]` plus
`importOrigin`. Nothing downstream changes: the adjudication pipeline, the asserted-claims
register, the approval gate and the `import` gap source are all untouched.

## Scope

XLSX and CSV only. `.docx` and PDF stay out of scope, as Spec A left them: security
questionnaires are overwhelmingly spreadsheets, and prose formats need a different extractor
and a different confidence story.

## Design decisions

### F1 · Upload is a staging resource, not a second questionnaire path

An upload creates a `questionnaire_imports` row, not a questionnaire. The row holds the
extracted grid and, once the job returns, the proposed mapping. Only `confirm` creates a
questionnaire, and it does so by calling the **existing** create service with
`{question, importedAnswer?}[]` and `importOrigin`.

The questionnaire model does not learn about files, sheets, columns or uploads. If the
extraction half were deleted tomorrow, paste would still work byte-for-byte.

### F2 · Deterministic parse, inferred mapping

Reading cells out of a file is deterministic and needs no model: unzip, walk the sheet XML,
produce `sheets: [{name, rows: string[][]}]`. Deciding *which* column is the question is not
deterministic and cannot be hardcoded — layout variance across questionnaire families is
unbounded, and every hardcoded heuristic is a rule some vendor's workbook breaks.

So: parse in code, map with a model. The split also means a mapping failure never costs the
parse, and a re-map never re-reads a file that no longer exists (F4).

### F3 · The mapping job returns coordinates, never text

`map_questionnaire_columns` is a queued, provider-routed, non-interactive metered job
([ai-jobs.md](../../ai-jobs.md)) — the API never calls a chat model inline. Its input is a
**bounded sample** per sheet (≈30 rows × 25 columns, cells truncated), wrapped in the
untrusted-content delimiters exactly as Q20 wraps an imported answer: a spreadsheet from a
customer's procurement team is the same trust class as fetched web content.

Its output is **structural only** — per sheet a role (`questions` / `ignore`), a header row
index, and column indices for question / answer / response-type / section-heading, with a
confidence and a one-line reason. No cell text comes back from the model, and the server
slices its own stored grid using the returned indices.

That is the containment property, and it is worth stating plainly: a prompt injection buried
in a spreadsheet cell can at worst produce a **wrong mapping**, which is precisely what the
human confirmation gate (F5) exists to catch. It cannot inject content into a questionnaire
item, because no model-authored text is ever on the path from file to item.

### F4 · Nothing at rest

The uploaded bytes are parsed inside the request and dropped. They are never written to disk,
never stored in a blob, never persisted at all — the file is customer material, and the
cheapest way to be right about retention is to have nothing to retain.

What persists is the extracted grid in `questionnaire_imports.sheets`, and it is nulled on
confirm or discard, leaving filename, format and the confirmed mapping as the audit trail.
Imports that are neither confirmed nor discarded are swept after **24 hours**, lazily on
create/list — drip-style derived state in the manner of Q24, so an API restart can never
strand customer material behind a wedged timer.

A bad *mapping* is recoverable without the file — the grid is still there, so the operator
edits it or the job re-runs. A bad *parse*, or anything noticed after confirm, means
re-uploading. That is the deliberate trade: the operator still has the file, and Magpie
should not.

### F5 · The human confirms the mapping before any answering starts

`confirm` is the gate. Until it is called, no questionnaire exists, no `answer_question_batch`
job is enqueued, and no AI spend beyond the single mapping call has been incurred. A
mis-parsed sheet caught here costs one cheap job; caught after answering it costs a full
bounded adjudication run and pollutes the match corpus with junk questions.

The operator sees, per sheet: the detected role, the mapping as editable column selects,
include/exclude, the first rows rendered as they would be created, and counts. The mapping
they confirm is applied by the same pure function that produced the preview — what was
approved is what gets created.

### F6 · Unclassified rows are surfaced, never dropped

Rows the mapping cannot classify as question, answer or heading get their own list in the
preview, with the reason (blank question cell, above the header row, heading-like) and a
promote-to-question control. A count-only "142 rows skipped" would make the gate a rubber
stamp: the one failure this design must catch — a mis-detected question column — reads as a
clean import when the rows it lost are invisible.

### F7 · One upload may span sheets; the operator picks which

A workbook whose domains are split across tabs is one questionnaire to the customer who sent
it, and splitting it into several Magpie questionnaires would fragment the worksheet, the
register and the approval flow for no gain. Included sheets concatenate into one
questionnaire, in sheet order, with the sheet name carried as a section prefix on each
question.

Auto-merging every question-like sheet is rejected: it silently pulls in glossary,
instructions and revision-history tabs whenever the classifier is wrong.

### F8 · Never a dead end

Every failure leaves a usable state, the posture Q26 takes with the approval gate:

| Failure | Result |
|---|---|
| unreadable / oversized / empty file | `400` at upload with the reason; nothing is stored |
| mapping job fails or dead-letters | import lands `failed` with a message; re-map or fall back to paste |
| model classifies nothing | import lands `mapped` with an empty proposal; the operator maps by hand |
| operator disagrees with the mapping | every field is editable before confirm |

## Data model

Migration `0066_questionnaire_imports.sql`, additive.

| Column | Shape |
|---|---|
| `id` | text pk |
| `flow_id` | the flow the questionnaire will be created in |
| `filename`, `format` | `xlsx` / `csv`; `filename` becomes the questionnaire's `import_origin` |
| `status` | `mapping` → `mapped` → `confirmed`, or `failed` |
| `sheets` | jsonb, the extracted grid; **nulled** on confirm/discard |
| `mapping` | jsonb, the job's proposal, then the operator's confirmed version |
| `error` | nullable message for `failed` |
| `questionnaire_id` | set on confirm |
| `created_at` | drives the 24h sweep |

Limits, enforced at upload: 5 MB, 20 sheets, 5 000 rows/sheet, 60 columns, and cell text
capped at the existing 20 000-char imported-answer cap. The 500-question cap stays exactly
where it is, enforced by the create service at confirm.

## Interfaces

| Route | Scope | Notes |
|---|---|---|
| `POST /api/questionnaire-imports` | `ask:knowledge` + flow `ask`, `trigger` tier | multipart (`file`, `flowId`); parses, stores the grid, enqueues the job; `202 {importId, status, sheets:[{name,rowCount,columnCount}]}` |
| `GET /api/questionnaire-imports/:id` | `read:knowledge` + flow `read` | status, proposed mapping, bounded preview, unclassified rows and counts |
| `POST /api/questionnaire-imports/:id/confirm` | `manage:knowledge` + flow `manage` | `{sheets:[{index, include, mapping}], promoteRows?}`; creates the questionnaire, nulls the grid; `201` with the initial worksheet |
| `DELETE /api/questionnaire-imports/:id` | `manage:knowledge` + flow `manage` | discard |

Cross-flow reads follow the reads-as-404 convention, as the rest of the questionnaire surface
does.

Job contract in `packages/jobs` (per the add-a-job-type skill): `map_questionnaire_columns`,
provider-routed, non-interactive, metered by the global AI cap, repairable (its output reworks
material already in the input and carries no grounding, so a single-shot reshape is safe). The
completion side-effect handler in `apps/api/src/features/jobs/service.ts` folds the proposal
onto the import row and flips it to `mapped`.

Console: `QuestionnaireCreateList` gains an upload path; a new `ImportMappingPreview` renders
the per-sheet mapping as `<select>`s, the preview rows, and the unclassified list. Selects
also keep it testable under the happy-dom harness, which does not fire `onChange` for text
inputs.

MCP is unchanged: extraction is console/API-only, as export already is.

## Parsing

CSV is parsed in-repo — a small RFC-4180 reader with BOM handling and delimiter sniffing
(comma / semicolon / tab).

XLSX needs a dependency. `fflate` (unzip; zero-dep, MIT, maintained) plus `fast-xml-parser`
for `sharedStrings.xml` and the sheet parts. Rejected: `exceljs`, which drags in `archiver`,
`unzipper`, `jszip` and `tmp` for a read-only text extraction and has not shipped since 2024;
and hand-scraping OOXML with regexes, which is the classic trap — inline rich-text runs and
entity handling are exactly where it breaks.

Extraction reads cached values only; formulas are never evaluated.

## Testing

- The parsers, against small committed fixtures (a multi-sheet workbook, a CSV with quoted
  embedded newlines, a semicolon file, an empty sheet).
- **The apply-mapping function, hardest of all** — it is the correctness surface, pure, and
  shared by preview and confirm. Header row skipping, heading rows, blank question cells,
  multi-sheet concatenation and the section prefix, promoted rows.
- Routes: upload limits and rejections, flow scoping, the 500-question cap at confirm, the
  grid actually being nulled, and the sweep.
- `packages/jobs`: the `map_questionnaire_columns` contract, capability routing and policy.
- Watcher: the runner, including a sheet whose cells contain injection text — the assertion
  being that the output is still only indices.
- Web: `ImportMappingPreview` mapping edits, include/exclude, promote, and the confirm submit.

## Rejected alternatives

- **Parse in the browser and upload only the grid.** The strongest privacy posture, and it
  puts a spreadsheet parser in the web bundle and leaves API and MCP callers unable to upload
  at all. Parse-and-drop server-side gets almost all of the benefit with one implementation.
- **Store the original file for a retention window.** Makes a bad mapping re-doable without a
  re-upload, and in exchange puts customer files at rest and requires a retention policy that
  must then be right forever. The operator still has the file.
- **Hardcoded column heuristics ("a column headed Question").** Free and fast on the
  questionnaires you tested it against. Layout variance is unbounded and the failure is
  silent.
- **Skip the confirmation gate and answer straight away.** One fewer screen, and it converts
  every mis-parse into wasted AI spend plus a match corpus polluted with instruction text.
- **Map the file's answers with the model and return the extracted text.** Puts
  model-authored text on the path from an untrusted file into a questionnaire item, and
  destroys the containment property of F3.
