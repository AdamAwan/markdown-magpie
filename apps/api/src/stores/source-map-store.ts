import { randomUUID } from "node:crypto";
import type { SourceMapEntry } from "@magpie/core";

// The write shape for one hint. Keyed on (sourceId, topic): an upsert with an
// existing key replaces that entry's paths/description/sha (latest observation
// wins), preserving id and createdAt. If the new hint's paths overlap with the
// existing entry's paths above a threshold (Jaccard similarity > 0.5), the
// consensus count is incremented (capped at 5).
export interface SourceMapUpsert {
  sourceId: string;
  topic: string;
  paths: string[];
  description: string;
  observedSha?: string;
}

// Persistent, agent-maintained navigation hints per source repository (#215).
// Internal metadata for source-grounded prompts — never answer-retrieval or
// user-facing content. Entry-level merge semantics (one row per topic) so
// concurrent jobs never clobber a whole document.
export interface SourceMapStore {
  // Entries for one source, most-recently-updated first (ties broken by
  // most-recent write), capped by limit. Both backends guarantee this ordering.
  listBySource(sourceId: string, limit: number): Promise<SourceMapEntry[]>;
  // Insert or replace the entry for (sourceId, topic).
  upsert(update: SourceMapUpsert): Promise<SourceMapEntry>;
  // Delete the oldest-updated entries beyond `limit`, returning how many went.
  pruneToLimit(sourceId: string, limit: number): Promise<number>;
  reset(): Promise<void>;
}

function entryKey(sourceId: string, topic: string): string {
  return `${sourceId}\0${topic}`;
}

// Computes Jaccard similarity of two path sets: |intersection| / |union|.
// Returns a value in [0, 1], where 1.0 means identical sets.
function jaccardSimilarity(paths1: string[], paths2: string[]): number {
  const set1 = new Set(paths1);
  const set2 = new Set(paths2);
  const intersection = [...set1].filter((p) => set2.has(p)).length;
  const union = new Set([...set1, ...set2]).size;
  return union === 0 ? 0 : intersection / union;
}

// Max consensus count to keep the data model simple.
const MAX_CONSENSUS_COUNT = 5;

export class InMemorySourceMapStore implements SourceMapStore {
  private readonly entries = new Map<string, SourceMapEntry>();
  // updatedAt has only millisecond resolution, so synchronous upserts in the
  // same tick can tie on timestamp; a monotonic write-sequence tie-break keeps
  // "most-recently-updated first" reflecting true write order rather than an
  // arbitrary (and here, wrong) alphabetical fallback.
  private readonly writeSequence = new Map<string, number>();
  private nextSequence = 0;

  async listBySource(sourceId: string, limit: number): Promise<SourceMapEntry[]> {
    return [...this.entries.values()]
      .filter((entry) => entry.sourceId === sourceId)
      .sort((left, right) => {
        const byTime = right.updatedAt.localeCompare(left.updatedAt);
        if (byTime !== 0) {
          return byTime;
        }
        const leftSeq = this.writeSequence.get(entryKey(left.sourceId, left.topic)) ?? 0;
        const rightSeq = this.writeSequence.get(entryKey(right.sourceId, right.topic)) ?? 0;
        return rightSeq - leftSeq;
      })
      .slice(0, limit);
  }

  async upsert(update: SourceMapUpsert): Promise<SourceMapEntry> {
    const now = new Date().toISOString();
    const key = entryKey(update.sourceId, update.topic);
    const existing = this.entries.get(key);

    // Determine consensus count based on path overlap with existing entry
    let consensusCount = 1;
    if (existing) {
      const similarity = jaccardSimilarity(update.paths, existing.paths);
      // If new paths overlap sufficiently with existing paths, agents agree
      if (similarity > 0.5) {
        consensusCount = Math.min(existing.consensusCount + 1, MAX_CONSENSUS_COUNT);
      } else {
        // Otherwise reset to 1 (contradicting hint)
        consensusCount = 1;
      }
    }

    const entry: SourceMapEntry = {
      id: existing?.id ?? randomUUID(),
      sourceId: update.sourceId,
      topic: update.topic,
      paths: [...update.paths],
      description: update.description,
      ...(update.observedSha ? { observedSha: update.observedSha } : {}),
      consensusCount,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.entries.set(key, entry);
    this.writeSequence.set(key, this.nextSequence++);
    return entry;
  }

  async pruneToLimit(sourceId: string, limit: number): Promise<number> {
    const ordered = await this.listBySource(sourceId, Number.MAX_SAFE_INTEGER);
    const evict = ordered.slice(limit);
    for (const entry of evict) {
      const key = entryKey(entry.sourceId, entry.topic);
      this.entries.delete(key);
      this.writeSequence.delete(key);
    }
    return evict.length;
  }

  async reset(): Promise<void> {
    this.entries.clear();
    this.writeSequence.clear();
  }
}
