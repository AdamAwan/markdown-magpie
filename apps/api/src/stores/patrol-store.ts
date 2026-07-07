export type PatrolCursorKind = "fix" | "improve";

export interface PatrolCursorEntry {
  docPath: string;
  lastCheckedAt: string;
  // The document's content hash and the hash of the flow's source-descriptor
  // set recorded the last time this doc was actually checked (#163). Undefined
  // until the first check records them — so a never-checked doc never matches
  // the change gate.
  contentHash?: string;
  sourcesHash?: string;
}

// What stampChecked records for one document. A bare string is shorthand for
// "advance last_checked_at, leave the recorded hashes untouched" — the pre-#163
// behaviour every caller that doesn't gate on content still relies on. A
// PatrolCursorStamp additionally records the content/source hashes the change
// gate compares against next tick.
export type PatrolStamp = string | PatrolCursorStamp;

export interface PatrolCursorStamp {
  docPath: string;
  contentHash?: string;
  sourcesHash?: string;
}

// The patrol cursor for a flow: when each document was last checked. Fix and
// improve patrols keep separate cursor freshness so editorial growth does not make
// correctness checks look recent. (Run history is the generic MaintenanceRun store,
// not here.)
export interface PatrolStore {
  // The cursor for a flow (default flow = undefined): when each doc was last checked.
  listCursor(flowId: string | undefined, kind?: PatrolCursorKind): Promise<PatrolCursorEntry[]>;
  // Upsert last_checked_at = now() for each doc in one batch. A stamp that carries
  // hashes records them (so the change gate can skip an unchanged doc next tick); a
  // stamp with no hash preserves whatever hashes the row already holds — so stamping
  // a doc purely to rotate it (e.g. one skipped because an open PR covers it) never
  // erases the verified state from its last real check.
  stampChecked(flowId: string | undefined, stamps: readonly PatrolStamp[], kind?: PatrolCursorKind): Promise<void>;
  reset(): Promise<void>;
}

// A stable key for the (cursor kind, optional flow id, doc path) tuple so each
// patrol owns its freshness without requiring a separate table.
function cursorKey(flowId: string | undefined, docPath: string, kind: PatrolCursorKind): string {
  return `${kind}\0${flowId ?? ""}\0${docPath}`;
}

// Normalises the mixed string/stamp input into the structured form both stores
// operate on, so a bare path string means "no new hashes to record".
export function normalizePatrolStamp(stamp: PatrolStamp): PatrolCursorStamp {
  return typeof stamp === "string" ? { docPath: stamp } : stamp;
}

export class InMemoryPatrolStore implements PatrolStore {
  private readonly cursor = new Map<
    string,
    {
      flowId: string | undefined;
      kind: PatrolCursorKind;
      docPath: string;
      lastCheckedAt: string;
      contentHash?: string;
      sourcesHash?: string;
    }
  >();

  async listCursor(flowId: string | undefined, kind: PatrolCursorKind = "fix"): Promise<PatrolCursorEntry[]> {
    return [...this.cursor.values()]
      .filter((entry) => (entry.flowId ?? "") === (flowId ?? "") && entry.kind === kind)
      .map((entry) => ({
        docPath: entry.docPath,
        lastCheckedAt: entry.lastCheckedAt,
        contentHash: entry.contentHash,
        sourcesHash: entry.sourcesHash
      }));
  }

  async stampChecked(
    flowId: string | undefined,
    stamps: readonly PatrolStamp[],
    kind: PatrolCursorKind = "fix"
  ): Promise<void> {
    const now = new Date().toISOString();
    for (const raw of stamps) {
      const stamp = normalizePatrolStamp(raw);
      const key = cursorKey(flowId, stamp.docPath, kind);
      const existing = this.cursor.get(key);
      // Mirror the Postgres COALESCE: a stamp with no hash keeps the prior one.
      this.cursor.set(key, {
        flowId,
        kind,
        docPath: stamp.docPath,
        lastCheckedAt: now,
        contentHash: stamp.contentHash ?? existing?.contentHash,
        sourcesHash: stamp.sourcesHash ?? existing?.sourcesHash
      });
    }
  }

  async reset(): Promise<void> {
    this.cursor.clear();
  }
}
