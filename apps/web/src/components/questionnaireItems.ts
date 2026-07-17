import type { QuestionnaireItem } from "@magpie/core";
import type { StatusTone } from "../theme/theme";

// Pure presentation helpers for a questionnaire item's badge, shared by the
// detail worksheet and its tests. Extracted from the old QuestionnairesPanel so
// the create-list and detail components can both render item badges without
// duplicating the status/outcome mapping.

export function itemTone(item: QuestionnaireItem): StatusTone {
  if (item.status === "unanswerable") return "failed";
  if (item.status === "pending" || item.status === "answering") return "pending";
  if (item.outcome === "reused") return "completed";
  if (item.outcome === "changed") return "running";
  return "neutral";
}

export function itemLabel(item: QuestionnaireItem): string {
  if (item.status === "pending") return "queued";
  if (item.status === "answering") return "answering";
  if (item.status === "unanswerable") return "unanswerable";
  if (item.status === "approved") return "approved";
  return item.outcome ?? "answered";
}

export function changeReasonText(item: QuestionnaireItem): string {
  const reason = item.changeReason;
  if (!reason) return "";
  const where = reason.heading || reason.path;
  const when = reason.changedAt ? ` on ${reason.changedAt.slice(0, 10)}` : "";
  if (reason.kind === "new_content") {
    return `Re-answered: new relevant content appeared${where ? ` — ${where}` : ""}${when}.`;
  }
  if (reason.kind === "section_changed") {
    return `Re-answered: cited section “${where}” changed${when}.`;
  }
  return `Re-answered: cited section “${where}” no longer exists.`;
}
