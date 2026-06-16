import { createHash } from "node:crypto";
import type { GapCandidate, SuggestedGapCluster } from "@magpie/core";

// Pure helpers for turning a chat model's proposed gap grouping into concrete
// SuggestedGapClusters. Kept out of main.ts so they can be unit-tested without
// booting the HTTP server, and so the matching/coverage rules live in one place.

export function titleFromGapSummary(summary: string): string {
  const normalized = summary
    .replace(/^no (?:sufficient )?source material found for:\s*/i, "")
    .replace(/[?.!]+$/g, "")
    .trim();
  if (!normalized) {
    return "Knowledge Gap Proposal";
  }

  return normalized
    .split(/\s+/)
    .slice(0, 10)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

export function normalizeSummary(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

// Deterministic, order-independent id so the same grouping keeps a stable key
// across refreshes (the UI relies on it for React keys and edit tracking).
export function clusterId(summaries: string[]): string {
  const hash = createHash("sha1").update([...summaries].sort().join(" ")).digest("hex");
  return `cluster-${hash.slice(0, 12)}`;
}

export function buildCluster(
  members: GapCandidate[],
  title: string | undefined,
  rationale: string | undefined
): SuggestedGapCluster {
  const summaries = members.map((member) => member.summary);
  const questionIds = [...new Set(members.flatMap((member) => member.questionIds))];
  return {
    id: clusterId(summaries),
    title: title?.trim() || titleFromGapSummary(summaries[0] ?? ""),
    summaries,
    questionIds,
    count: questionIds.length,
    rationale: rationale?.trim() || undefined
  };
}

export function singletonCluster(candidate: GapCandidate): SuggestedGapCluster {
  return buildCluster([candidate], titleFromGapSummary(candidate.summary), undefined);
}

// Maps a model's proposed grouping back onto real candidates. Summaries are
// matched exactly, then case-insensitively; any candidate the model dropped or
// duplicated is given its own cluster so nothing disappears from the reviewer's
// view and no gap is drafted twice.
export function assembleClusters(candidates: GapCandidate[], parsed: unknown): SuggestedGapCluster[] {
  const bySummary = new Map(candidates.map((candidate) => [candidate.summary, candidate]));
  const byNormalized = new Map(candidates.map((candidate) => [normalizeSummary(candidate.summary), candidate]));
  const groups = (parsed as { clusters?: Array<{ title?: unknown; summaries?: unknown; rationale?: unknown }> } | undefined)
    ?.clusters;

  const clusters: SuggestedGapCluster[] = [];
  const assigned = new Set<string>();

  if (Array.isArray(groups)) {
    for (const group of groups) {
      const rawSummaries = Array.isArray(group?.summaries) ? group.summaries : [];
      const members: GapCandidate[] = [];
      for (const raw of rawSummaries) {
        if (typeof raw !== "string") {
          continue;
        }
        const candidate = bySummary.get(raw) ?? byNormalized.get(normalizeSummary(raw));
        if (!candidate || assigned.has(candidate.summary)) {
          continue;
        }
        assigned.add(candidate.summary);
        members.push(candidate);
      }
      if (members.length === 0) {
        continue;
      }
      clusters.push(
        buildCluster(
          members,
          typeof group?.title === "string" ? group.title : undefined,
          typeof group?.rationale === "string" ? group.rationale : undefined
        )
      );
    }
  }

  for (const candidate of candidates) {
    if (!assigned.has(candidate.summary)) {
      assigned.add(candidate.summary);
      clusters.push(singletonCluster(candidate));
    }
  }

  return clusters;
}
