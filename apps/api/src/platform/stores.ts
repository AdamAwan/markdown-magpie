import { InMemoryGapClusterStore } from "../stores/gap-cluster-store.js";
import { PostgresGapClusterStore } from "../stores/postgres-gap-cluster-store.js";
import { PostgresPrCrosslinkStore } from "../stores/postgres-pr-crosslink-store.js";
import { PostgresProposalStore } from "../stores/postgres-proposal-store.js";
import { PostgresQuestionLogStore } from "../stores/postgres-question-log-store.js";
import { PostgresReconciliationDecisionStore } from "../stores/postgres-reconciliation-decision-store.js";
import { PostgresScheduledTaskStore } from "../stores/postgres-scheduled-task-store.js";
import { PostgresPatrolStore } from "../stores/postgres-patrol-store.js";
import { PostgresSourceMapStore } from "../stores/postgres-source-map-store.js";
import { PostgresSourceSyncStore } from "../stores/postgres-source-sync-store.js";
import { PostgresWatcherRegistryStore } from "../stores/postgres-watcher-registry-store.js";
import { InMemoryProposalStore } from "../stores/proposal-store.js";
import {
  InMemoryGapClosureVerificationStore,
  PostgresGapClosureVerificationStore
} from "../stores/gap-closure-verification-store.js";
import { InMemoryPrCrosslinkStore } from "../stores/pr-crosslink-store.js";
import { InMemoryQuestionLogStore } from "../stores/question-log-store.js";
import { InMemoryReconciliationDecisionStore } from "../stores/reconciliation-decision-store.js";
import { InMemoryMaintenanceRunStore } from "../stores/maintenance-run-store.js";
import { PostgresMaintenanceRunStore } from "../stores/postgres-maintenance-run-store.js";
import { InMemoryScheduledTaskStore } from "../stores/scheduled-task-store.js";
import { InMemoryPatrolStore } from "../stores/patrol-store.js";
import { InMemorySeedPlanStore } from "../stores/seed-plan-store.js";
import { PostgresSeedPlanStore } from "../stores/postgres-seed-plan-store.js";
import { InMemorySourceMapStore } from "../stores/source-map-store.js";
import { InMemorySourceSyncStore } from "../stores/source-sync-store.js";
import { InMemoryWatcherRegistryStore } from "../stores/watcher-registry-store.js";
import { FileSnapshotStore, type SnapshotStore } from "../stores/snapshot-store.js";
import { NullInsightsStore, type InsightsStore } from "../stores/insights-store.js";
import { PostgresInsightsStore } from "../stores/postgres-insights-store.js";
import { snapshotRoot } from "./repositories.js";
import type { AppConfig, StoreEnvName } from "./config.js";
import type pg from "pg";

// The resolved backend for a given store: its explicit override, or the default.
export function storeBackend(config: AppConfig, name: StoreEnvName): "memory" | "postgres" {
  return config.storage.overrides[name] ?? config.storage.default;
}

// Pick the Postgres or in-memory implementation for a store. Postgres-backed
// stores share the single process-wide pool (see platform/db-pool.ts) rather
// than each opening their own, so connection use stays bounded.
function createStore<T>(
  config: AppConfig,
  pool: pg.Pool,
  name: StoreEnvName,
  postgres: (pool: pg.Pool) => T,
  memory: () => T
): T {
  if (storeBackend(config, name) === "postgres") {
    return postgres(pool);
  }
  return memory();
}

export function createQuestionLogStore(config: AppConfig, pool: pg.Pool): InMemoryQuestionLogStore | PostgresQuestionLogStore {
  return createStore<InMemoryQuestionLogStore | PostgresQuestionLogStore>(
    config,
    pool,
    "QUESTION_LOG_STORE",
    (pool) => new PostgresQuestionLogStore(pool),
    () => new InMemoryQuestionLogStore()
  );
}

export function createProposalStore(config: AppConfig, pool: pg.Pool): InMemoryProposalStore | PostgresProposalStore {
  return createStore<InMemoryProposalStore | PostgresProposalStore>(
    config,
    pool,
    "PROPOSAL_STORE",
    (pool) => new PostgresProposalStore(pool),
    () => new InMemoryProposalStore()
  );
}

export function createGapClosureVerificationStore(
  config: AppConfig,
  pool: pg.Pool
): InMemoryGapClosureVerificationStore | PostgresGapClosureVerificationStore {
  return createStore<InMemoryGapClosureVerificationStore | PostgresGapClosureVerificationStore>(
    config,
    pool,
    "GAP_CLOSURE_VERIFICATION_STORE",
    (pool) => new PostgresGapClosureVerificationStore(pool),
    () => new InMemoryGapClosureVerificationStore()
  );
}

export function createScheduledTaskStore(config: AppConfig, pool: pg.Pool): InMemoryScheduledTaskStore | PostgresScheduledTaskStore {
  return createStore<InMemoryScheduledTaskStore | PostgresScheduledTaskStore>(
    config,
    pool,
    "SCHEDULED_TASK_STORE",
    (pool) => new PostgresScheduledTaskStore(pool),
    () => new InMemoryScheduledTaskStore()
  );
}

export function createSourceSyncStore(config: AppConfig, pool: pg.Pool): InMemorySourceSyncStore | PostgresSourceSyncStore {
  return createStore<InMemorySourceSyncStore | PostgresSourceSyncStore>(
    config,
    pool,
    "SOURCE_SYNC_STORE",
    (pool) => new PostgresSourceSyncStore(pool),
    () => new InMemorySourceSyncStore()
  );
}

export function createSourceMapStore(config: AppConfig, pool: pg.Pool): InMemorySourceMapStore | PostgresSourceMapStore {
  return createStore<InMemorySourceMapStore | PostgresSourceMapStore>(
    config,
    pool,
    "SOURCE_MAP_STORE",
    (pool) => new PostgresSourceMapStore(pool),
    () => new InMemorySourceMapStore()
  );
}

export function createSeedPlanStore(config: AppConfig, pool: pg.Pool): InMemorySeedPlanStore | PostgresSeedPlanStore {
  return createStore<InMemorySeedPlanStore | PostgresSeedPlanStore>(
    config,
    pool,
    "SEED_PLAN_STORE",
    (pool) => new PostgresSeedPlanStore(pool),
    () => new InMemorySeedPlanStore()
  );
}

export function createPatrolStore(config: AppConfig, pool: pg.Pool): InMemoryPatrolStore | PostgresPatrolStore {
  return createStore<InMemoryPatrolStore | PostgresPatrolStore>(
    config,
    pool,
    "PATROL_STORE",
    (pool) => new PostgresPatrolStore(pool),
    () => new InMemoryPatrolStore()
  );
}

export function createGapClusterStore(config: AppConfig, pool: pg.Pool): InMemoryGapClusterStore | PostgresGapClusterStore {
  return createStore<InMemoryGapClusterStore | PostgresGapClusterStore>(
    config,
    pool,
    "GAP_CLUSTER_STORE",
    (pool) => new PostgresGapClusterStore(pool),
    () => new InMemoryGapClusterStore()
  );
}

export function createReconciliationDecisionStore(
  config: AppConfig,
  pool: pg.Pool
): InMemoryReconciliationDecisionStore | PostgresReconciliationDecisionStore {
  return createStore<InMemoryReconciliationDecisionStore | PostgresReconciliationDecisionStore>(
    config,
    pool,
    "RECONCILIATION_DECISION_STORE",
    (pool) => new PostgresReconciliationDecisionStore(pool),
    () => new InMemoryReconciliationDecisionStore()
  );
}

export function createMaintenanceRunStore(config: AppConfig, pool: pg.Pool): InMemoryMaintenanceRunStore | PostgresMaintenanceRunStore {
  return createStore<InMemoryMaintenanceRunStore | PostgresMaintenanceRunStore>(
    config,
    pool,
    "MAINTENANCE_RUN_STORE",
    (pool) => new PostgresMaintenanceRunStore(pool),
    () => new InMemoryMaintenanceRunStore()
  );
}

export function createWatcherRegistryStore(config: AppConfig, pool: pg.Pool): InMemoryWatcherRegistryStore | PostgresWatcherRegistryStore {
  return createStore<InMemoryWatcherRegistryStore | PostgresWatcherRegistryStore>(
    config,
    pool,
    "WATCHER_REGISTRY_STORE",
    (pool) => new PostgresWatcherRegistryStore(pool),
    () => new InMemoryWatcherRegistryStore()
  );
}

export function createPrCrosslinkStore(config: AppConfig, pool: pg.Pool): InMemoryPrCrosslinkStore | PostgresPrCrosslinkStore {
  return createStore<InMemoryPrCrosslinkStore | PostgresPrCrosslinkStore>(
    config,
    pool,
    "PR_CROSSLINK_STORE",
    (pool) => new PostgresPrCrosslinkStore(pool),
    () => new InMemoryPrCrosslinkStore()
  );
}

// The snapshot is an on-disk artifact (the downloaded-data location), so there is
// no Postgres variant; unit tests swap in InMemorySnapshotStore via the test context.
export function createSnapshotStore(config: AppConfig): SnapshotStore {
  return new FileSnapshotStore(snapshotRoot(config));
}

// Insights is read-only aggregation that only makes sense over Postgres, so it
// is Postgres-backed whenever a pool exists (production and DB-backed tests) and
// a no-op otherwise (in-memory unit tests get NullInsightsStore).
export function createInsightsStore(pool: pg.Pool | undefined, pgBossSchema: string): InsightsStore {
  return pool ? new PostgresInsightsStore(pool, pgBossSchema) : new NullInsightsStore();
}
