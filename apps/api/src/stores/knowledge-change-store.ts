import { randomUUID } from "node:crypto";
import {
  KNOWLEDGE_CHANGE_CAUSES,
  KNOWLEDGE_CHANGE_KINDS,
  type KnowledgeChange,
  type KnowledgeChangeCause,
  type KnowledgeChangeKind
} from "@magpie/core";

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

// What narrows a read of the log. Every field is optional and they compose: each
// one supplied is an AND, so "this flow, since Monday, caused by a source sync" is
// one query. `flowIds` and `documentId` are the two indexed axes (the feed and the
// per-document timeline); the rest narrow within them.
export interface KnowledgeChangeFilters {
  /**
   * The flows this read covers — an explicit filter, or the set a role-scoped
   * caller may read. Entries with no flow (a repository that is nobody's
   * destination) are outside every such set, so they are visible only to a read
   * that names no flows at all.
   */
  flowIds?: string[];
  documentId?: string;
  sourceId?: string;
  /** Inclusive lower bound on `changedAt`, as an ISO instant. */
  since?: string;
  /** Exclusive upper bound on `changedAt`, as an ISO instant. */
  until?: string;
  cause?: KnowledgeChangeCause;
  kind?: KnowledgeChangeKind;
}

export interface KnowledgeChangeQuery extends KnowledgeChangeFilters {
  limit: number;
  offset: number;
}

// The aggregate over the SAME filtered window the rows come from — not the whole
// table. Counts are keyed by every kind and cause, zeros included, so a caller can
// render a stable breakdown without knowing which values happened to occur.
export interface KnowledgeChangeCounts {
  total: number;
  byKind: Record<KnowledgeChangeKind, number>;
  byCause: Record<KnowledgeChangeCause, number>;
  /** Distinct documents touched in the filtered window. */
  documentsTouched: number;
}

// One (documentId, anchor) the caller wants the latest entry for. The durable
// section identity of KC-1, and exactly what a retrieved section already carries.
export interface KnowledgeChangeSectionRef {
  documentId: string;
  anchor: string;
}

/** The scope a "when did this log start?" read is asked within. */
export type KnowledgeChangeScope = Pick<KnowledgeChangeFilters, "flowIds" | "documentId" | "sourceId">;

export function emptyKnowledgeChangeCounts(): KnowledgeChangeCounts {
  return {
    total: 0,
    byKind: Object.fromEntries(KNOWLEDGE_CHANGE_KINDS.map((kind) => [kind, 0])) as Record<KnowledgeChangeKind, number>,
    byCause: Object.fromEntries(KNOWLEDGE_CHANGE_CAUSES.map((cause) => [cause, 0])) as Record<
      KnowledgeChangeCause,
      number
    >,
    documentsTouched: 0
  };
}

// The append-only knowledge change log (spec 2026-08-27-knowledge-change-log).
// Written from the index-time diff, the one choke point every corpus change
// passes through, and read back through the filtered query below.
export interface KnowledgeChangeStore {
  // Appends entries, skipping ones already recorded for the same
  // (documentId, anchor, kind, commitSha). Re-indexing is not rare — a merge, a
  // restart, and the PR poller can each drive one, and the job-completion replay
  // path deliberately re-runs side effects — so recording the same transition
  // twice must be a no-op, not a duplicate. Returns how many rows were appended.
  record(entries: KnowledgeChangeRecord[]): Promise<number>;
  // Newest first, filtered and paginated.
  list(query: KnowledgeChangeQuery): Promise<KnowledgeChange[]>;
  // The aggregate over the filtered window `list` pages through, computed in the
  // backend rather than by counting fetched rows — the window is unbounded and the
  // page is not.
  summarize(filters: KnowledgeChangeFilters): Promise<KnowledgeChangeCounts>;
  // The most recent entry for each of the given (documentId, anchor) pairs, in ONE
  // call for the whole set — this runs on the answer path, which is latency
  // sensitive, so a per-section query is not an option. Refs with no history are
  // simply absent from the result: a section the log has never seen carries no
  // change context, and silence is the correct answer there.
  latestForSections(refs: KnowledgeChangeSectionRef[]): Promise<KnowledgeChange[]>;
  // The earliest instant recorded in the given scope, so an empty window reads as
  // "nothing recorded yet" rather than "nothing changed". Undefined when the scope
  // holds no entries at all.
  firstChangedAt(scope: KnowledgeChangeScope): Promise<string | undefined>;
  reset(): Promise<void>;
}

export function sectionKey(documentId: string, anchor: string): string {
  return `${documentId}\u0000${anchor}`;
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

  async list(query: KnowledgeChangeQuery): Promise<KnowledgeChange[]> {
    return this.matching(query)
      .reverse()
      .slice(query.offset, query.offset + query.limit);
  }

  async summarize(filters: KnowledgeChangeFilters): Promise<KnowledgeChangeCounts> {
    const counts = emptyKnowledgeChangeCounts();
    const documents = new Set<string>();
    for (const entry of this.matching(filters)) {
      counts.total += 1;
      counts.byKind[entry.kind] += 1;
      counts.byCause[entry.cause] += 1;
      documents.add(entry.documentId);
    }
    counts.documentsTouched = documents.size;
    return counts;
  }

  async latestForSections(refs: KnowledgeChangeSectionRef[]): Promise<KnowledgeChange[]> {
    if (refs.length === 0) {
      return [];
    }
    const wanted = new Set(refs.map((ref) => sectionKey(ref.documentId, ref.anchor)));
    const latest = new Map<string, KnowledgeChange>();
    for (const entry of this.entries) {
      if (entry.anchor === undefined) {
        continue;
      }
      const key = sectionKey(entry.documentId, entry.anchor);
      if (!wanted.has(key)) {
        continue;
      }
      const held = latest.get(key);
      if (held === undefined || held.changedAt <= entry.changedAt) {
        latest.set(key, entry);
      }
    }
    return [...latest.values()];
  }

  async firstChangedAt(scope: KnowledgeChangeScope): Promise<string | undefined> {
    let earliest: string | undefined;
    for (const entry of this.matching(scope)) {
      if (earliest === undefined || entry.changedAt < earliest) {
        earliest = entry.changedAt;
      }
    }
    return earliest;
  }

  async reset(): Promise<void> {
    this.entries.length = 0;
  }

  // Oldest first, as appended. Every supplied filter is an AND; the callers that
  // want newest-first reverse it.
  private matching(filters: KnowledgeChangeFilters): KnowledgeChange[] {
    return this.entries.filter((entry) => {
      if (filters.flowIds !== undefined && (entry.flowId === undefined || !filters.flowIds.includes(entry.flowId)))
        return false;
      if (filters.documentId !== undefined && entry.documentId !== filters.documentId) return false;
      if (filters.sourceId !== undefined && entry.sourceId !== filters.sourceId) return false;
      if (filters.cause !== undefined && entry.cause !== filters.cause) return false;
      if (filters.kind !== undefined && entry.kind !== filters.kind) return false;
      // ISO-8601 UTC instants compare correctly as strings, and both bounds are
      // normalized to that form before they reach a store.
      if (filters.since !== undefined && entry.changedAt < filters.since) return false;
      if (filters.until !== undefined && entry.changedAt >= filters.until) return false;
      return true;
    });
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
