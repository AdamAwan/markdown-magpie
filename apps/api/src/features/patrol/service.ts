import type { AppContext } from "../../context.js";
import type { PatrolRun } from "@magpie/core";
import { selectFlow } from "../../platform/repositories.js";
import { selectPatrolBatch } from "../../scheduling/patrol-cursor.js";

// Cursor knobs (tunable). batchSize bounds per-tick cost; randomCount is the
// explore share (~20%); the remainder is the oldest/most-stale exploit share.
// See docs/maintenance-redesign.md (Decisions: cursor fairness).
const PATROL_BATCH_SIZE = 10;
const PATROL_RANDOM_COUNT = 2;

export type FixPatrolOutcome = { ok: true; run: PatrolRun } | { ok: false; code: "unknown_flow" };

// Resolve a flow to the repository ids whose documents the cursor rotates over.
// Mirrors the retrieve service: a flow scopes to its destination repo; the default
// flow (undefined) is unscoped (every indexed repository).
function resolveRepositoryIds(
  ctx: AppContext,
  flowId: string | undefined
): { ok: true; repositoryIds: string[] | undefined } | { ok: false; code: "unknown_flow" } {
  if (!flowId) {
    return { ok: true, repositoryIds: undefined };
  }
  const flow = selectFlow(ctx.repositoryDeps(), flowId);
  if (!flow) {
    return { ok: false, code: "unknown_flow" };
  }
  return { ok: true, repositoryIds: flow.destinationId ? [flow.destinationId] : undefined };
}

export async function runFixPatrol(
  ctx: AppContext,
  options: { flowId?: string; trigger: PatrolRun["trigger"] }
): Promise<FixPatrolOutcome> {
  const scope = resolveRepositoryIds(ctx, options.flowId);
  if (!scope.ok) {
    return scope;
  }

  const universe = ctx.stores.knowledgeIndex
    .listDocuments()
    .filter((doc) => !scope.repositoryIds || scope.repositoryIds.includes(doc.repositoryId))
    .map((doc) => doc.path);

  const cursor = await ctx.stores.patrol.listCursor(options.flowId);
  const checkedAt = new Map(cursor.map((entry) => [entry.docPath, entry.lastCheckedAt]));

  const selected = selectPatrolBatch(universe, checkedAt, {
    batchSize: PATROL_BATCH_SIZE,
    randomCount: PATROL_RANDOM_COUNT
  });

  // No-op lens slot: later increments run the verify/dedupe/split lenses over
  // `selected` here and emit ChangeIntents through the reconcile gate. The
  // skeleton only advances the cursor and records the visit.
  await ctx.stores.patrol.stampChecked(options.flowId, selected);

  const run = await ctx.stores.patrol.createRun({
    flowId: options.flowId,
    trigger: options.trigger,
    universeCount: universe.length,
    selectedCount: selected.length,
    selected
  });
  console.log(
    `Fix-patrol (${options.trigger}) flow=${options.flowId ?? "(default)"}: ` +
      `checked ${selected.length}/${universe.length} document(s); run ${run.id}.`
  );
  return { ok: true, run };
}

export async function listRuns(ctx: AppContext, limit: number): Promise<PatrolRun[]> {
  return ctx.stores.patrol.listRuns(limit);
}

export async function getRun(ctx: AppContext, id: string): Promise<PatrolRun | undefined> {
  return ctx.stores.patrol.getRun(id);
}
