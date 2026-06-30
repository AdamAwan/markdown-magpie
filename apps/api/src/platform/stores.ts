import { InMemoryGapClusterStore } from "../stores/gap-cluster-store.js";
import { PostgresGapClusterStore } from "../stores/postgres-gap-cluster-store.js";
import { PostgresPrCrosslinkStore } from "../stores/postgres-pr-crosslink-store.js";
import { PostgresProposalStore } from "../stores/postgres-proposal-store.js";
import { PostgresQuestionLogStore } from "../stores/postgres-question-log-store.js";
import { PostgresReconciliationDecisionStore } from "../stores/postgres-reconciliation-decision-store.js";
import { PostgresScheduledTaskStore } from "../stores/postgres-scheduled-task-store.js";
import { PostgresPatrolStore } from "../stores/postgres-patrol-store.js";
import { PostgresSourceSyncStore } from "../stores/postgres-source-sync-store.js";
import { PostgresWatcherRegistryStore } from "../stores/postgres-watcher-registry-store.js";
import { InMemoryProposalStore } from "../stores/proposal-store.js";
import { InMemoryPrCrosslinkStore } from "../stores/pr-crosslink-store.js";
import { InMemoryQuestionLogStore } from "../stores/question-log-store.js";
import { InMemoryReconciliationDecisionStore } from "../stores/reconciliation-decision-store.js";
import { InMemoryMaintenanceRunStore } from "../stores/maintenance-run-store.js";
import { PostgresMaintenanceRunStore } from "../stores/postgres-maintenance-run-store.js";
import { InMemoryScheduledTaskStore } from "../stores/scheduled-task-store.js";
import { InMemoryPatrolStore } from "../stores/patrol-store.js";
import { InMemorySourceSyncStore } from "../stores/source-sync-store.js";
import { InMemoryWatcherRegistryStore } from "../stores/watcher-registry-store.js";
import { FileSnapshotStore, type SnapshotStore } from "../stores/snapshot-store.js";
import { snapshotRoot } from "./repositories.js";
import type { AppConfig, StoreEnvName } from "./config.js";

// The resolved backend for a given store: its explicit override, or the default.
export function storeBackend(config: AppConfig, name: StoreEnvName): "memory" | "postgres" {
  return config.storage.overrides[name] ?? config.storage.default;
}

// Pick the Postgres or in-memory implementation for a store. DATABASE_URL is
// validated as required at startup, so a postgres-backed store can rely on it.
function createStore<T>(
  config: AppConfig,
  name: StoreEnvName,
  postgres: (databaseUrl: string) => T,
  memory: () => T
): T {
  if (storeBackend(config, name) === "postgres") {
    return postgres(config.databaseUrl);
  }
  return memory();
}

export function createQuestionLogStore(config: AppConfig): InMemoryQuestionLogStore | PostgresQuestionLogStore {
  return createStore<InMemoryQuestionLogStore | PostgresQuestionLogStore>(
    config,
    "QUESTION_LOG_STORE",
    (databaseUrl) => new PostgresQuestionLogStore(databaseUrl),
    () => new InMemoryQuestionLogStore()
  );
}

export function createProposalStore(config: AppConfig): InMemoryProposalStore | PostgresProposalStore {
  return createStore<InMemoryProposalStore | PostgresProposalStore>(
    config,
    "PROPOSAL_STORE",
    (databaseUrl) => new PostgresProposalStore(databaseUrl),
    () => new InMemoryProposalStore()
  );
}

export function createScheduledTaskStore(config: AppConfig): InMemoryScheduledTaskStore | PostgresScheduledTaskStore {
  return createStore<InMemoryScheduledTaskStore | PostgresScheduledTaskStore>(
    config,
    "SCHEDULED_TASK_STORE",
    (databaseUrl) => new PostgresScheduledTaskStore(databaseUrl),
    () => new InMemoryScheduledTaskStore()
  );
}

export function createSourceSyncStore(config: AppConfig): InMemorySourceSyncStore | PostgresSourceSyncStore {
  return createStore<InMemorySourceSyncStore | PostgresSourceSyncStore>(
    config,
    "SOURCE_SYNC_STORE",
    (databaseUrl) => new PostgresSourceSyncStore(databaseUrl),
    () => new InMemorySourceSyncStore()
  );
}

export function createPatrolStore(config: AppConfig): InMemoryPatrolStore | PostgresPatrolStore {
  return createStore<InMemoryPatrolStore | PostgresPatrolStore>(
    config,
    "PATROL_STORE",
    (databaseUrl) => new PostgresPatrolStore(databaseUrl),
    () => new InMemoryPatrolStore()
  );
}

export function createGapClusterStore(config: AppConfig): InMemoryGapClusterStore | PostgresGapClusterStore {
  return createStore<InMemoryGapClusterStore | PostgresGapClusterStore>(
    config,
    "GAP_CLUSTER_STORE",
    (databaseUrl) => new PostgresGapClusterStore(databaseUrl),
    () => new InMemoryGapClusterStore()
  );
}

export function createReconciliationDecisionStore(
  config: AppConfig
): InMemoryReconciliationDecisionStore | PostgresReconciliationDecisionStore {
  return createStore<InMemoryReconciliationDecisionStore | PostgresReconciliationDecisionStore>(
    config,
    "RECONCILIATION_DECISION_STORE",
    (databaseUrl) => new PostgresReconciliationDecisionStore(databaseUrl),
    () => new InMemoryReconciliationDecisionStore()
  );
}

export function createMaintenanceRunStore(config: AppConfig): InMemoryMaintenanceRunStore | PostgresMaintenanceRunStore {
  return createStore<InMemoryMaintenanceRunStore | PostgresMaintenanceRunStore>(
    config,
    "MAINTENANCE_RUN_STORE",
    (databaseUrl) => new PostgresMaintenanceRunStore(databaseUrl),
    () => new InMemoryMaintenanceRunStore()
  );
}

export function createWatcherRegistryStore(config: AppConfig): InMemoryWatcherRegistryStore | PostgresWatcherRegistryStore {
  return createStore<InMemoryWatcherRegistryStore | PostgresWatcherRegistryStore>(
    config,
    "WATCHER_REGISTRY_STORE",
    (databaseUrl) => new PostgresWatcherRegistryStore(databaseUrl),
    () => new InMemoryWatcherRegistryStore()
  );
}

export function createPrCrosslinkStore(config: AppConfig): InMemoryPrCrosslinkStore | PostgresPrCrosslinkStore {
  return createStore<InMemoryPrCrosslinkStore | PostgresPrCrosslinkStore>(
    config,
    "PR_CROSSLINK_STORE",
    (databaseUrl) => new PostgresPrCrosslinkStore(databaseUrl),
    () => new InMemoryPrCrosslinkStore()
  );
}

// The snapshot is an on-disk artifact (the downloaded-data location), so there is
// no Postgres variant; unit tests swap in InMemorySnapshotStore via the test context.
export function createSnapshotStore(config: AppConfig): SnapshotStore {
  return new FileSnapshotStore(snapshotRoot(config));
}
