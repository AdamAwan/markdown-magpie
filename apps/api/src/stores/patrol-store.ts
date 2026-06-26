export type PatrolCursorKind = "fix" | "improve";

export interface PatrolCursorEntry {
  docPath: string;
  lastCheckedAt: string;
}

// The patrol cursor for a flow: when each document was last checked. Fix and
// improve patrols keep separate cursor freshness so editorial growth does not make
// correctness checks look recent. (Run history is the generic MaintenanceRun store,
// not here.)
export interface PatrolStore {
  // The cursor for a flow (default flow = undefined): when each doc was last checked.
  listCursor(flowId: string | undefined, kind?: PatrolCursorKind): Promise<PatrolCursorEntry[]>;
  // Upsert last_checked_at = now() for each doc in one batch.
  stampChecked(flowId: string | undefined, docPaths: string[], kind?: PatrolCursorKind): Promise<void>;
  reset(): Promise<void>;
}

// A stable key for the (cursor kind, optional flow id, doc path) tuple so each
// patrol owns its freshness without requiring a separate table.
function cursorKey(flowId: string | undefined, docPath: string, kind: PatrolCursorKind): string {
  return `${kind}\0${flowId ?? ""}\0${docPath}`;
}

export class InMemoryPatrolStore implements PatrolStore {
  private readonly cursor = new Map<
    string,
    { flowId: string | undefined; kind: PatrolCursorKind; docPath: string; lastCheckedAt: string }
  >();

  async listCursor(flowId: string | undefined, kind: PatrolCursorKind = "fix"): Promise<PatrolCursorEntry[]> {
    return [...this.cursor.values()]
      .filter((entry) => (entry.flowId ?? "") === (flowId ?? "") && entry.kind === kind)
      .map((entry) => ({ docPath: entry.docPath, lastCheckedAt: entry.lastCheckedAt }));
  }

  async stampChecked(flowId: string | undefined, docPaths: string[], kind: PatrolCursorKind = "fix"): Promise<void> {
    const now = new Date().toISOString();
    for (const docPath of docPaths) {
      this.cursor.set(cursorKey(flowId, docPath, kind), { flowId, kind, docPath, lastCheckedAt: now });
    }
  }

  async reset(): Promise<void> {
    this.cursor.clear();
  }
}
