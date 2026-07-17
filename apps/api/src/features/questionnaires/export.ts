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

function provenanceLine(item: QuestionnaireItem): string | undefined {
  switch (item.outcome) {
    case "reused":
      return "Source: reused from a prior approved answer";
    case "adapted":
      return "Source: adapted from a prior approved answer";
    case "merged":
      return "Source: merged from prior approved answers";
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
