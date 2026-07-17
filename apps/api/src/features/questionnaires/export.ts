import type { Questionnaire, QuestionnaireItem } from "@magpie/core";

// Pure export rendering for a questionnaire worksheet. Markdown for pasting
// into documents; CSV (RFC 4180 quoting) for spreadsheet-driven portals.
export function exportQuestionnaire(questionnaire: Questionnaire, format: "md" | "csv"): string {
  return format === "md" ? toMarkdown(questionnaire) : toCsv(questionnaire);
}

function toMarkdown(questionnaire: Questionnaire): string {
  const lines: string[] = [`# ${questionnaire.name}`, ""];
  for (const item of questionnaire.items) {
    lines.push(`## ${item.position + 1}. ${item.question}`, "");
    if (item.status !== "unanswerable" && item.answer) {
      if (item.confidence === "low" || item.confidence === "unknown") {
        lines.push(`> ⚠ Low confidence — review`, "");
      }
      const provenance = provenanceLine(item);
      if (provenance) {
        lines.push(`> ${provenance}`, "");
      }
      lines.push(item.answer, "");
    } else {
      lines.push("_No answer available._", "");
    }
  }
  return lines.join("\n");
}

// NOTE: the task-3 brief's provenanceLine also switches on "adapted" and
// "merged" outcomes, but QuestionnaireItemOutcome (packages/core) is
// currently only "reused" | "fresh" | "changed" — those values arrive in a
// later task. Adding those case labels now fails tsc (TS2678: string
// literal not comparable to the outcome union), so they're deliberately
// omitted here rather than worked around with a cast. Extend this switch
// when QuestionnaireItemOutcome widens to include them.
function provenanceLine(item: QuestionnaireItem): string | undefined {
  switch (item.outcome) {
    case "reused":
      return "Source: reused from a prior approved answer";
    default:
      return undefined;
  }
}

function toCsv(questionnaire: Questionnaire): string {
  const rows = [["position", "question", "answer", "status", "confidence", "outcome"]];
  for (const item of questionnaire.items) {
    rows.push([
      String(item.position + 1),
      item.question,
      item.status === "unanswerable" ? "" : (item.answer ?? ""),
      item.status,
      item.confidence ?? "",
      item.outcome ?? ""
    ]);
  }
  return rows.map((row) => row.map(csvField).join(",")).join("\r\n");
}

function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}
