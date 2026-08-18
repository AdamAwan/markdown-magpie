import { useState } from "react";
import type { ImportSheetPreview, QuestionnaireImport, SheetMapping } from "@magpie/core";
import styled from "@emotion/styled";
import { Actions, Badge, Button, Field, Row, Select, Stack } from "./ui";

export interface ConfirmImportBody {
  sheets: Array<{ sheetIndex: number; include: boolean; mapping: SheetMapping }>;
  promoted?: string[];
}

interface ImportMappingPreviewProps {
  data: { import: QuestionnaireImport; preview: ImportSheetPreview[] };
  onConfirm: (body: ConfirmImportBody) => void;
  onDiscard: () => void;
  confirming?: boolean;
}

// The confirmation gate for an uploaded questionnaire (docs/questionnaires.md
// Q33). Nothing has been created yet and no answering has started: what the
// operator approves here is exactly what gets created, because the server
// re-applies this mapping with the same function that produced this preview.
//
// Every mapping control is a <select> of column indices, which is also what
// keeps this testable under the happy-dom harness.
export function ImportMappingPreview({ data, onConfirm, onDiscard, confirming = false }: ImportMappingPreviewProps) {
  const [mappings, setMappings] = useState<SheetMapping[]>(() => initialMappings(data));
  const [excluded, setExcluded] = useState<number[]>([]);
  const [promoted, setPromoted] = useState<string[]>([]);

  function patch(sheetIndex: number, patchValue: Partial<SheetMapping>) {
    setMappings((current) =>
      current.map((mapping) => (mapping.sheetIndex === sheetIndex ? { ...mapping, ...patchValue } : mapping))
    );
  }

  function toggle<T>(list: T[], value: T): T[] {
    return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
  }

  const includedCount = data.preview.filter((sheet) => !excluded.includes(sheet.sheetIndex)).length;

  return (
    <Stack gap="lg">
      <Row gap="sm" wrap>
        <strong>{data.import.filename}</strong>
        <Badge tone={data.import.status === "failed" ? "failed" : "neutral"}>{data.import.status}</Badge>
        <Muted>
          Nothing has been created yet. Check where the questions and previous answers are, then create the
          questionnaire — every imported answer is adjudicated against the knowledge base, never trusted.
        </Muted>
      </Row>

      {data.import.status === "failed" ? (
        // A failed mapping is a terminal state carrying its reason (#366), so it is
        // shown as an error rather than left as a "mapping" badge that never
        // resolves. The grid survives a failure, so the recovery is always the same:
        // map by hand right here.
        <ErrorLine role="alert">
          {data.import.error ?? "the automatic column mapping failed"}. Map the columns by hand below, or discard the
          upload and paste the questions instead.
        </ErrorLine>
      ) : null}

      {data.import.status === "mapping" ? (
        <Muted role="status">
          Working out which columns hold what. You can map the columns by hand now rather than wait.
        </Muted>
      ) : null}

      {data.preview.map((sheet) => {
        const mapping = mappings.find((entry) => entry.sheetIndex === sheet.sheetIndex);
        const include = !excluded.includes(sheet.sheetIndex);
        if (!mapping) {
          return null;
        }
        return (
          <SheetCard key={sheet.sheetIndex}>
            <Row gap="sm" wrap>
              <label>
                <input
                  type="checkbox"
                  checked={include}
                  aria-label={`Include ${sheet.name}`}
                  onChange={() => setExcluded((current) => toggle(current, sheet.sheetIndex))}
                />{" "}
                <strong>{sheet.name}</strong>
              </label>
              <Muted>
                {sheet.rowCount} rows · {sheet.questionCount} questions · {sheet.unclassifiedCount} unclassified
              </Muted>
              <Badge tone={mapping.confidence === "high" ? "completed" : "pending"}>
                {mapping.confidence} confidence
              </Badge>
              <Muted>{mapping.reason}</Muted>
            </Row>

            {include ? (
              <>
                <ColumnGrid>
                  <ColumnPicker
                    label={`${sheet.name} · Header row`}
                    value={mapping.headerRow}
                    options={sheet.headerSample.map((_, rowIndex) => ({
                      value: rowIndex,
                      label: `Row ${rowIndex + 1}`
                    }))}
                    onChange={(value) => patch(sheet.sheetIndex, { headerRow: value })}
                  />
                  {COLUMN_FIELDS.map((field) => (
                    <ColumnPicker
                      key={field.key}
                      label={`${sheet.name} · ${field.label}`}
                      value={mapping[field.key]}
                      options={columnOptions(sheet)}
                      onChange={(value) => patch(sheet.sheetIndex, { [field.key]: value })}
                    />
                  ))}
                </ColumnGrid>

                {sheet.sampleRows.length > 0 ? (
                  <SampleList>
                    {sheet.sampleRows.map((row) => (
                      <li key={row.rowIndex}>
                        {row.kind === "heading" ? <Badge tone="neutral">section</Badge> : null} {row.question}
                        {row.importedAnswer ? <Muted> → {row.importedAnswer}</Muted> : null}
                      </li>
                    ))}
                  </SampleList>
                ) : (
                  <Muted>No questions detected on this sheet with the current mapping.</Muted>
                )}

                {sheet.unclassifiedRows.length > 0 ? (
                  <details>
                    <summary>{sheet.unclassifiedCount} rows not taken as questions</summary>
                    <SampleList>
                      {sheet.unclassifiedRows.map((row) => {
                        const key = `${sheet.sheetIndex}:${row.rowIndex}`;
                        return (
                          <li key={key}>
                            <label>
                              <input
                                type="checkbox"
                                checked={promoted.includes(key)}
                                aria-label={`Promote row ${row.rowIndex + 1} of ${sheet.name}`}
                                onChange={() => setPromoted((current) => toggle(current, key))}
                              />{" "}
                              {row.question || <Muted>(blank)</Muted>}
                            </label>{" "}
                            <Muted>{row.reason}</Muted>
                          </li>
                        );
                      })}
                    </SampleList>
                  </details>
                ) : null}
              </>
            ) : null}
          </SheetCard>
        );
      })}

      <Actions>
        <Button
          disabled={confirming || includedCount === 0}
          onClick={() =>
            onConfirm({
              sheets: data.preview.map((sheet) => ({
                sheetIndex: sheet.sheetIndex,
                include: !excluded.includes(sheet.sheetIndex),
                mapping:
                  mappings.find((entry) => entry.sheetIndex === sheet.sheetIndex) ?? blankMapping(sheet.sheetIndex)
              })),
              ...(promoted.length > 0 ? { promoted } : {})
            })
          }
        >
          Create questionnaire
        </Button>
        <Button variant="ghost" onClick={onDiscard}>
          Discard upload
        </Button>
      </Actions>
    </Stack>
  );
}

const COLUMN_FIELDS = [
  { key: "questionColumn", label: "Question column" },
  { key: "answerColumn", label: "Previous answer column" },
  { key: "responseTypeColumn", label: "Response type column" },
  { key: "sectionHeadingColumn", label: "Section heading column" }
] as const satisfies ReadonlyArray<{ key: keyof SheetMapping; label: string }>;

function initialMappings(data: { import: QuestionnaireImport; preview: ImportSheetPreview[] }): SheetMapping[] {
  return data.preview.map(
    (sheet) =>
      data.import.mapping?.find((entry) => entry.sheetIndex === sheet.sheetIndex) ?? blankMapping(sheet.sheetIndex)
  );
}

function blankMapping(sheetIndex: number): SheetMapping {
  return {
    sheetIndex,
    role: "questions",
    headerRow: null,
    questionColumn: null,
    answerColumn: null,
    responseTypeColumn: null,
    sectionHeadingColumn: null,
    confidence: "low",
    reason: "not mapped"
  };
}

// Column options are labelled by what the header row actually says, so the
// operator picks "Response" rather than "column 2".
function columnOptions(sheet: ImportSheetPreview): Array<{ value: number; label: string }> {
  const header = sheet.headerSample.reduce<string[]>((widest, row) => (row.length > widest.length ? row : widest), []);
  return Array.from({ length: sheet.columnCount }, (_, index) => ({
    value: index,
    label: header[index]?.trim() ? `${columnLetter(index)} · ${header[index].trim().slice(0, 30)}` : columnLetter(index)
  }));
}

function columnLetter(index: number): string {
  let letters = "";
  let remaining = index;
  do {
    letters = String.fromCharCode(65 + (remaining % 26)) + letters;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return letters;
}

interface ColumnPickerProps {
  label: string;
  value: number | null;
  options: Array<{ value: number; label: string }>;
  onChange: (value: number | null) => void;
}

// "None" is a first-class option: a null column is corrected in one click, while
// a wrong one silently imports the wrong text.
function ColumnPicker({ label, value, options, onChange }: ColumnPickerProps) {
  return (
    <Field label={label}>
      <Select
        aria-label={label}
        value={value === null ? "" : String(value)}
        onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
      >
        <option value="">None</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}

const SheetCard = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.md,
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.md,
  padding: theme.space.lg
}));

const ColumnGrid = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.md,
  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))"
}));

const SampleList = styled.ul(({ theme }) => ({
  display: "grid",
  gap: theme.space.sm,
  margin: 0,
  padding: `0 0 0 ${theme.space.lg}`,
  fontSize: theme.font.size.sm
}));

const ErrorLine = styled.p(({ theme }) => ({
  margin: 0,
  color: theme.color.status.failed.fg,
  fontSize: theme.font.size.sm
}));

const Muted = styled.span(({ theme }) => ({
  color: theme.color.textMuted,
  fontSize: theme.font.size.sm
}));
