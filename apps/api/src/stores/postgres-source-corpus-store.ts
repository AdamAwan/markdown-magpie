import pg from "pg";
import type { SourceDataContext } from "@magpie/core";
import { SOURCE_CORPUS_RETENTION_MS, type SourceCorpusStore } from "./source-corpus-store.js";

// Postgres-backed content-addressed corpus store (see SourceCorpusStore). One row
// per distinct corpus (primary key = hash), so an unchanged corpus across ticks
// reuses its row. Every save also prunes rows that fell out of the retention
// window, keeping the table bounded to the corpus versions of recent ticks.
export class PostgresSourceCorpusStore implements SourceCorpusStore {
  constructor(private readonly pool: pg.Pool) {}

  async save(hash: string, corpus: readonly SourceDataContext[]): Promise<void> {
    // Upsert the snapshot, then prune stale rows. The corpus is the hash's digest,
    // so an existing row's payload is identical — the conflict path only refreshes
    // last_used_at so a corpus still in active use is never pruned out from under
    // an in-flight job.
    await this.pool.query(
      `
        INSERT INTO source_corpus_snapshot (hash, corpus)
        VALUES ($1, $2::jsonb)
        ON CONFLICT (hash) DO UPDATE SET last_used_at = now()
      `,
      [hash, JSON.stringify(corpus)]
    );
    await this.pool.query(
      "DELETE FROM source_corpus_snapshot WHERE last_used_at < now() - ($1::double precision * interval '1 millisecond')",
      [SOURCE_CORPUS_RETENTION_MS]
    );
  }

  async get(hash: string): Promise<SourceDataContext[] | undefined> {
    const result = await this.pool.query<{ corpus: SourceDataContext[] }>(
      "SELECT corpus FROM source_corpus_snapshot WHERE hash = $1",
      [hash]
    );
    return result.rows[0]?.corpus;
  }
}
