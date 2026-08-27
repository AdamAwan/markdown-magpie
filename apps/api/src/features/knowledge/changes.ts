import {
  KNOWLEDGE_CHANGE_CAUSES,
  KNOWLEDGE_CHANGE_KINDS,
  type KnowledgeChange,
  type KnowledgeChangeCause,
  type KnowledgeChangeKind
} from "@magpie/core";
import type { KnowledgeChangeCounts, KnowledgeChangeFilters } from "../../stores/knowledge-change-store.js";

// The read side of the knowledge change log (spec 2026-08-27-knowledge-change-log,
// rollout step 3). Pure query parsing and view types; the store does the filtering
// and the aggregation, and the service joins the attribution decorations on.

// One entry as the API returns it: the stored change, plus the upstream file
// counts where the causing commit range is known.
export interface KnowledgeChangeView extends KnowledgeChange {
  /**
   * How many files the causing upstream commit range touched, and how many of
   * them the sync run actually examined. Present only for a `source_sync` entry
   * whose run still resolves. A cap applies (SOURCE_SYNC_MAX_CHANGED_FILES), and
   * a log that implied completeness it does not have would be worse than no log,
   * so both numbers travel together.
   */
  upstream?: { changedFileCount: number; examinedFileCount: number };
}

export interface KnowledgeChangesReport {
  changes: KnowledgeChangeView[];
  summary: KnowledgeChangeCounts & {
    /**
     * The earliest instant recorded within the requested scope (ignoring the time
     * window), or absent when the scope has never recorded anything. This is what
     * makes an empty week read as "nothing recorded yet" rather than "nothing
     * changed": the log starts at install and never backfills.
     */
    logStartedAt?: string;
  };
  limit: number;
  offset: number;
}

/** The raw query string values, exactly as they arrive on the request. */
export interface RawChangeQuery {
  flowId?: string | undefined;
  documentId?: string | undefined;
  sourceId?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
  cause?: string | undefined;
  kind?: string | undefined;
}

/** The identity half of the filters — the axes a `logStartedAt` read is scoped by. */
export interface ParsedChangeQuery extends Omit<KnowledgeChangeFilters, "flowIds"> {
  flowId?: string;
}

export type ParseChangeQueryOutcome =
  | { ok: true; query: ParsedChangeQuery }
  | { ok: false; code: "invalid_cause" | "invalid_kind" | "invalid_since" | "invalid_until" };

function isCause(value: string): value is KnowledgeChangeCause {
  return (KNOWLEDGE_CHANGE_CAUSES as readonly string[]).includes(value);
}

function isKind(value: string): value is KnowledgeChangeKind {
  return (KNOWLEDGE_CHANGE_KINDS as readonly string[]).includes(value);
}

// Normalizes a caller-supplied instant to ISO-8601 UTC, which is how entries are
// stored and how both backends compare. Accepts anything Date can parse (a date
// alone, "2026-08-01", is the common console case) and rejects everything else
// rather than silently widening the window to "all of time".
function parseInstant(value: string): string | undefined {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * Validates the query string of `GET /api/knowledge/changes`. An unknown enum
 * value or an unparseable instant is a 400, not a silently ignored filter — a
 * change log that quietly answers a different question than the one asked is the
 * failure mode this whole feature exists to avoid.
 */
export function parseChangeQuery(raw: RawChangeQuery): ParseChangeQueryOutcome {
  const query: ParsedChangeQuery = {};

  if (raw.flowId) query.flowId = raw.flowId;
  if (raw.documentId) query.documentId = raw.documentId;
  if (raw.sourceId) query.sourceId = raw.sourceId;

  if (raw.cause) {
    if (!isCause(raw.cause)) {
      return { ok: false, code: "invalid_cause" };
    }
    query.cause = raw.cause;
  }

  if (raw.kind) {
    if (!isKind(raw.kind)) {
      return { ok: false, code: "invalid_kind" };
    }
    query.kind = raw.kind;
  }

  if (raw.since) {
    const since = parseInstant(raw.since);
    if (!since) {
      return { ok: false, code: "invalid_since" };
    }
    query.since = since;
  }

  if (raw.until) {
    const until = parseInstant(raw.until);
    if (!until) {
      return { ok: false, code: "invalid_until" };
    }
    query.until = until;
  }

  return { ok: true, query };
}
