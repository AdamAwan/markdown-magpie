import type { SourceDataContext } from "@magpie/core";

// A content-addressed store for the source corpus a patrol tick checks documents
// against (#163 Part 2). The corpus used to be copied by value into every
// verify/correct/improve job in a batch; now it is saved ONCE per tick keyed by
// its hash, and each job carries only that hash. The watcher fetches the corpus
// by ref (GET /api/source-corpus/:hash) and caches it across the jobs in a tick.
//
// Snapshots are prunable: jobs are short-lived, so a snapshot only has to outlive
// the in-flight jobs that reference it. The Postgres store deletes rows untouched
// for longer than RETENTION_MS; the in-memory store keeps them for the process
// lifetime (its use is tests/dev, where distinct corpus versions are few).
export interface SourceCorpusStore {
  // Store the corpus under its hash. Idempotent: saving the same hash again just
  // marks it freshly used (the corpus is identical by construction — the hash is
  // its digest).
  save(hash: string, corpus: readonly SourceDataContext[]): Promise<void>;
  // Resolve a previously saved corpus, or undefined when the hash is unknown
  // (never saved, or pruned after its referencing jobs completed).
  get(hash: string): Promise<SourceDataContext[] | undefined>;
}

// How long a snapshot is retained after it was last saved. A patrol tick and the
// jobs it enqueues complete in minutes, so a day is ample margin for the slowest
// in-flight job to still resolve its ref before the row is pruned.
export const SOURCE_CORPUS_RETENTION_MS = 24 * 60 * 60 * 1000;

export class InMemorySourceCorpusStore implements SourceCorpusStore {
  private readonly snapshots = new Map<string, SourceDataContext[]>();

  async save(hash: string, corpus: readonly SourceDataContext[]): Promise<void> {
    this.snapshots.set(hash, [...corpus]);
  }

  async get(hash: string): Promise<SourceDataContext[] | undefined> {
    const corpus = this.snapshots.get(hash);
    return corpus ? [...corpus] : undefined;
  }
}
