import { randomUUID } from "node:crypto";
import pg from "pg";
import type { KnowledgeChange } from "@magpie/core";
import {
  emptyKnowledgeChangeCounts,
  UNVERSIONED_DEDUPE_WINDOW_MS,
  type KnowledgeChangeCounts,
  type KnowledgeChangeFilters,
  type KnowledgeChangeQuery,
  type KnowledgeChangeRecord,
  type KnowledgeChangeScope,
  type KnowledgeChangeSectionRef,
  type KnowledgeChangeStore
} from "./knowledge-change-store.js";

// Builds the shared WHERE clause every read uses, so the rows and the summary can
// never disagree about what "the filtered window" means. Only the filters actually
// supplied become predicates; the rest of the log stays visible.
function whereClause(filters: KnowledgeChangeFilters): { sql: string; values: unknown[] } {
  const predicates: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    predicates.push(sql.replace("$?", `$${values.length}`));
  };

  // = ANY still index-scans (flow_id, changed_at DESC). An entry with no flow is
  // outside every named set, which NULL = ANY(...) already yields.
  if (filters.flowIds !== undefined) add("flow_id = ANY($?)", filters.flowIds);
  if (filters.documentId !== undefined) add("document_id = $?", filters.documentId);
  if (filters.sourceId !== undefined) add("source_id = $?", filters.sourceId);
  if (filters.cause !== undefined) add("cause = $?", filters.cause);
  if (filters.kind !== undefined) add("kind = $?", filters.kind);
  // Half-open window: `since` is inclusive, `until` exclusive, matching the
  // in-memory store so a day boundary belongs to exactly one window.
  if (filters.since !== undefined) add("changed_at >= $?", filters.since);
  if (filters.until !== undefined) add("changed_at < $?", filters.until);

  return { sql: predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "", values };
}

export class PostgresKnowledgeChangeStore implements KnowledgeChangeStore {
  constructor(private readonly pool: pg.Pool) {}

  async record(entries: KnowledgeChangeRecord[]): Promise<number> {
    if (entries.length === 0) {
      return 0;
    }

    let appended = 0;
    for (const entry of entries) {
      appended += await this.recordOne(entry);
    }
    return appended;
  }

  async list(query: KnowledgeChangeQuery): Promise<KnowledgeChange[]> {
    const { sql, values } = whereClause(query);
    // (flow_id, changed_at DESC) and (document_id, changed_at DESC) are the two
    // indexes this ordering is built for; id breaks ties so paging is stable when
    // one re-index writes several entries at the same instant.
    const result = await this.pool.query<KnowledgeChangeRow>(
      `SELECT * FROM knowledge_changes ${sql} ORDER BY changed_at DESC, id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, query.limit, query.offset]
    );
    return result.rows.map(mapRow);
  }

  // One aggregate pass over the filtered window, in SQL. GROUPING SETS gives the
  // per-kind rows, the per-cause rows and the grand total (which carries the
  // distinct-document count) from a single index scan — fetching the window and
  // counting in JS would mean reading an unbounded number of rows to summarize a
  // bounded page.
  async summarize(filters: KnowledgeChangeFilters): Promise<KnowledgeChangeCounts> {
    const { sql, values } = whereClause(filters);
    const result = await this.pool.query<SummaryRow>(
      `
        SELECT
          GROUPING(kind) AS kind_total,
          GROUPING(cause) AS cause_total,
          kind,
          cause,
          count(*)::int AS entries,
          count(DISTINCT document_id)::int AS documents
        FROM knowledge_changes
        ${sql}
        GROUP BY GROUPING SETS ((kind), (cause), ())
      `,
      values
    );

    const counts = emptyKnowledgeChangeCounts();
    for (const row of result.rows) {
      if (row.kind_total === 0 && row.kind) {
        counts.byKind[row.kind] = row.entries;
        continue;
      }
      if (row.cause_total === 0 && row.cause) {
        counts.byCause[row.cause] = row.entries;
        continue;
      }
      counts.total = row.entries;
      counts.documentsTouched = row.documents;
    }
    return counts;
  }

  // One round trip for the whole result set: the (document_id, anchor) pairs go
  // down as two parallel arrays and DISTINCT ON keeps the newest row per pair.
  // This runs on every ask, so a query per section is not an option — and unnest
  // keeps the parameter count at two however many sections came back.
  async latestForSections(refs: KnowledgeChangeSectionRef[]): Promise<KnowledgeChange[]> {
    if (refs.length === 0) {
      return [];
    }
    const result = await this.pool.query<KnowledgeChangeRow>(
      `
        SELECT DISTINCT ON (document_id, anchor) *
        FROM knowledge_changes
        WHERE (document_id, anchor) IN (SELECT * FROM unnest($1::text[], $2::text[]))
        ORDER BY document_id, anchor, changed_at DESC, id DESC
      `,
      [refs.map((ref) => ref.documentId), refs.map((ref) => ref.anchor)]
    );
    return result.rows.map(mapRow);
  }

  async firstChangedAt(scope: KnowledgeChangeScope): Promise<string | undefined> {
    const { sql, values } = whereClause(scope);
    const result = await this.pool.query<{ first_changed_at: Date | null }>(
      `SELECT min(changed_at) AS first_changed_at FROM knowledge_changes ${sql}`,
      values
    );
    return result.rows[0]?.first_changed_at?.toISOString();
  }

  async reset(): Promise<void> {
    await this.pool.query("DELETE FROM knowledge_changes");
  }

  // One append. Entries carrying a commit sha lean on the partial unique index
  // (knowledge_changes_dedupe_idx) with ON CONFLICT DO NOTHING, so two racing
  // re-indexes of the same commit cannot both win. Entries with no sha have no
  // exact key to conflict on — the index deliberately excludes them, since a
  // permanent (document, anchor, kind) key would swallow every later edit — so
  // they are guarded by a short-window NOT EXISTS probe instead.
  private async recordOne(entry: KnowledgeChangeRecord): Promise<number> {
    const values = [
      randomUUID(),
      entry.repositoryId,
      entry.documentId,
      entry.path,
      entry.anchor ?? null,
      entry.heading ?? null,
      entry.kind,
      entry.commitSha ?? null,
      entry.cause,
      entry.proposalId ?? null,
      entry.jobId ?? null,
      entry.sourceId ?? null,
      entry.sourceFromSha ?? null,
      entry.sourceToSha ?? null,
      entry.summary ?? null,
      entry.flowId ?? null
    ];

    const columns = `
      id, repository_id, document_id, path, anchor, heading, kind, commit_sha, cause,
      proposal_id, job_id, source_id, source_from_sha, source_to_sha, summary, flow_id
    `;
    const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");

    if (entry.commitSha !== undefined) {
      const result = await this.pool.query(
        `INSERT INTO knowledge_changes (${columns}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
        values
      );
      return result.rowCount ?? 0;
    }

    const windowSeconds = UNVERSIONED_DEDUPE_WINDOW_MS / 1000;
    const result = await this.pool.query(
      `
        INSERT INTO knowledge_changes (${columns})
        SELECT ${placeholders}
        WHERE NOT EXISTS (
          SELECT 1 FROM knowledge_changes
          WHERE document_id = $3
            AND anchor IS NOT DISTINCT FROM $5
            AND kind = $7
            AND commit_sha IS NULL
            AND changed_at > now() - make_interval(secs => $${values.length + 1})
        )
      `,
      [...values, windowSeconds]
    );
    return result.rowCount ?? 0;
  }
}

// One GROUPING SETS row. The GROUPING() flags are 0 when the column is part of
// that row's grouping set and 1 when it was rolled up, which is what distinguishes
// a per-kind row from a per-cause row from the grand total.
interface SummaryRow {
  kind_total: number;
  cause_total: number;
  kind: KnowledgeChange["kind"] | null;
  cause: KnowledgeChange["cause"] | null;
  entries: number;
  documents: number;
}

interface KnowledgeChangeRow {
  id: string;
  repository_id: string;
  document_id: string;
  path: string;
  anchor: string | null;
  heading: string | null;
  kind: KnowledgeChange["kind"];
  changed_at: Date;
  commit_sha: string | null;
  cause: KnowledgeChange["cause"];
  proposal_id: string | null;
  job_id: string | null;
  source_id: string | null;
  source_from_sha: string | null;
  source_to_sha: string | null;
  summary: string | null;
  flow_id: string | null;
}

function mapRow(row: KnowledgeChangeRow): KnowledgeChange {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    documentId: row.document_id,
    path: row.path,
    anchor: row.anchor ?? undefined,
    heading: row.heading ?? undefined,
    kind: row.kind,
    changedAt: row.changed_at.toISOString(),
    commitSha: row.commit_sha ?? undefined,
    cause: row.cause,
    proposalId: row.proposal_id ?? undefined,
    jobId: row.job_id ?? undefined,
    sourceId: row.source_id ?? undefined,
    sourceFromSha: row.source_from_sha ?? undefined,
    sourceToSha: row.source_to_sha ?? undefined,
    summary: row.summary ?? undefined,
    flowId: row.flow_id ?? undefined
  };
}
