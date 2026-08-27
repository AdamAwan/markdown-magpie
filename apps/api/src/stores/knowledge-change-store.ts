import { randomUUID } from "node:crypto";
import type { KnowledgeChange } from "@magpie/core";

// One entry to append. Everything except the diff facts (document identity and
// kind) is attribution, and every attribution field is optional: a change entry
// whose cause never resolved is still a true record of a real change.
export interface KnowledgeChangeRecord {
  repositoryId: string;
  documentId: string;
  path: string;
  anchor?: string;
  heading?: string;
  kind: KnowledgeChange["kind"];
  commitSha?: string;
  cause: KnowledgeChange["cause"];
  proposalId?: string;
  jobId?: string;
  sourceId?: string;
  sourceFromSha?: string;
  sourceToSha?: string;
  summary?: string;
  flowId?: string;
}

// Why a re-index happened, threaded from the caller that knows. Attribution is a
// DECORATION on an independently-correct diff: a missing or unresolvable hint
// yields cause "external" and a still-correct entry, and nothing about the diff
// depends on the cause resolving.
export interface KnowledgeChangeAttribution {
  cause: KnowledgeChange["cause"];
  proposalId?: string;
  jobId?: string;
  sourceId?: string;
  sourceFromSha?: string;
  sourceToSha?: string;
  summary?: string;
}

// How long an entry with no commit_sha suppresses an identical re-record. The
// sha-keyed dedupe is exact, but a destination with no resolvable git context has
// no commit to key on: without a bound, "same document, anchor and kind" would
// dedupe forever and swallow the second real edit to a section. Comfortably longer
// than a completion replay, far shorter than a plausible gap between real edits.
export const UNVERSIONED_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

// The append-only knowledge change log (spec 2026-08-27-knowledge-change-log).
// Written from the index-time diff, the one choke point every corpus change
// passes through.
export interface KnowledgeChangeStore {
  // Appends entries, skipping ones already recorded for the same
  // (documentId, anchor, kind, commitSha). Re-indexing is not rare — a merge, a
  // restart, and the PR poller can each drive one, and the job-completion replay
  // path deliberately re-runs side effects — so recording the same transition
  // twice must be a no-op, not a duplicate. Returns how many rows were appended.
  record(entries: KnowledgeChangeRecord[]): Promise<number>;
  // Newest first. Read surfaces land in a later rollout step; this exists so the
  // write path is assertable.
  listRecent(limit: number): Promise<KnowledgeChange[]>;
  reset(): Promise<void>;
}

function dedupeKey(entry: Pick<KnowledgeChangeRecord, "documentId" | "anchor" | "kind" | "commitSha">): string {
  return [entry.documentId, entry.anchor ?? "", entry.kind, entry.commitSha ?? ""].join("\0");
}

export class InMemoryKnowledgeChangeStore implements KnowledgeChangeStore {
  private readonly entries: KnowledgeChange[] = [];

  async record(entries: KnowledgeChangeRecord[]): Promise<number> {
    const now = Date.now();
    let appended = 0;

    for (const entry of entries) {
      if (this.alreadyRecorded(entry, now)) {
        continue;
      }
      this.entries.push({
        id: randomUUID(),
        repositoryId: entry.repositoryId,
        documentId: entry.documentId,
        path: entry.path,
        ...(entry.anchor === undefined ? {} : { anchor: entry.anchor }),
        ...(entry.heading === undefined ? {} : { heading: entry.heading }),
        kind: entry.kind,
        changedAt: new Date(now).toISOString(),
        ...(entry.commitSha === undefined ? {} : { commitSha: entry.commitSha }),
        cause: entry.cause,
        ...(entry.proposalId === undefined ? {} : { proposalId: entry.proposalId }),
        ...(entry.jobId === undefined ? {} : { jobId: entry.jobId }),
        ...(entry.sourceId === undefined ? {} : { sourceId: entry.sourceId }),
        ...(entry.sourceFromSha === undefined ? {} : { sourceFromSha: entry.sourceFromSha }),
        ...(entry.sourceToSha === undefined ? {} : { sourceToSha: entry.sourceToSha }),
        ...(entry.summary === undefined ? {} : { summary: entry.summary }),
        ...(entry.flowId === undefined ? {} : { flowId: entry.flowId })
      });
      appended += 1;
    }

    return appended;
  }

  async listRecent(limit: number): Promise<KnowledgeChange[]> {
    return [...this.entries].reverse().slice(0, limit);
  }

  async reset(): Promise<void> {
    this.entries.length = 0;
  }

  // Mirrors the Postgres backend: an exact key match when the entry carries a
  // commit sha, a short-window match on (documentId, anchor, kind) when it does not.
  private alreadyRecorded(entry: KnowledgeChangeRecord, now: number): boolean {
    const key = dedupeKey(entry);
    return this.entries.some((existing) => {
      if (existing.commitSha !== entry.commitSha) {
        return false;
      }
      if (entry.commitSha === undefined) {
        return (
          existing.documentId === entry.documentId &&
          existing.anchor === entry.anchor &&
          existing.kind === entry.kind &&
          now - Date.parse(existing.changedAt) < UNVERSIONED_DEDUPE_WINDOW_MS
        );
      }
      return dedupeKey(existing) === key;
    });
  }
}
