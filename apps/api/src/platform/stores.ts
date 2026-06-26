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

export function storageBackend(): "memory" | "postgres" {
  return process.env.STORAGE_BACKEND === "postgres" ? "postgres" : "memory";
}

export type StoreEnvName =
  | "KNOWLEDGE_STORE"
  | "QUESTION_LOG_STORE"
  | "PROPOSAL_STORE"
  | "SCHEDULED_TASK_STORE"
  | "SOURCE_SYNC_STORE"
  | "PATROL_STORE"
  | "GAP_CLUSTER_STORE"
  | "RECONCILIATION_DECISION_STORE"
  | "MAINTENANCE_RUN_STORE"
  | "WATCHER_REGISTRY_STORE"
  | "PR_CROSSLINK_STORE";

export function storeBackend(name: StoreEnvName): "memory" | "postgres" {
  return process.env[name] === "postgres" ? "postgres" : storageBackend();
}

// Pick the Postgres or in-memory implementation for a store, with the same
// "DATABASE_URL is required when <NAME>=postgres" error every factory used to
// inline. Keeps the seven create* functions to a single line each.
function createStore<T>(name: StoreEnvName, postgres: (databaseUrl: string) => T, memory: () => T): T {
  if (storeBackend(name) === "postgres") {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error(`DATABASE_URL is required when ${name}=postgres`);
    }
    return postgres(databaseUrl);
  }
  return memory();
}

export function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for durable job execution");
  }
  return databaseUrl;
}

export function createQuestionLogStore(): InMemoryQuestionLogStore | PostgresQuestionLogStore {
  return createStore<InMemoryQuestionLogStore | PostgresQuestionLogStore>(
    "QUESTION_LOG_STORE",
    (databaseUrl) => new PostgresQuestionLogStore(databaseUrl),
    () => new InMemoryQuestionLogStore()
  );
}

export function createProposalStore(): InMemoryProposalStore | PostgresProposalStore {
  return createStore<InMemoryProposalStore | PostgresProposalStore>(
    "PROPOSAL_STORE",
    (databaseUrl) => new PostgresProposalStore(databaseUrl),
    () => new InMemoryProposalStore()
  );
}

export function createScheduledTaskStore(): InMemoryScheduledTaskStore | PostgresScheduledTaskStore {
  return createStore<InMemoryScheduledTaskStore | PostgresScheduledTaskStore>(
    "SCHEDULED_TASK_STORE",
    (databaseUrl) => new PostgresScheduledTaskStore(databaseUrl),
    () => new InMemoryScheduledTaskStore()
  );
}

export function createSourceSyncStore(): InMemorySourceSyncStore | PostgresSourceSyncStore {
  return createStore<InMemorySourceSyncStore | PostgresSourceSyncStore>(
    "SOURCE_SYNC_STORE",
    (databaseUrl) => new PostgresSourceSyncStore(databaseUrl),
    () => new InMemorySourceSyncStore()
  );
}

export function createPatrolStore(): InMemoryPatrolStore | PostgresPatrolStore {
  return createStore<InMemoryPatrolStore | PostgresPatrolStore>(
    "PATROL_STORE",
    (databaseUrl) => new PostgresPatrolStore(databaseUrl),
    () => new InMemoryPatrolStore()
  );
}

export function createGapClusterStore(): InMemoryGapClusterStore | PostgresGapClusterStore {
  return createStore<InMemoryGapClusterStore | PostgresGapClusterStore>(
    "GAP_CLUSTER_STORE",
    (databaseUrl) => new PostgresGapClusterStore(databaseUrl),
    () => new InMemoryGapClusterStore()
  );
}

export function createReconciliationDecisionStore():
  | InMemoryReconciliationDecisionStore
  | PostgresReconciliationDecisionStore {
  return createStore<InMemoryReconciliationDecisionStore | PostgresReconciliationDecisionStore>(
    "RECONCILIATION_DECISION_STORE",
    (databaseUrl) => new PostgresReconciliationDecisionStore(databaseUrl),
    () => new InMemoryReconciliationDecisionStore()
  );
}

export function createMaintenanceRunStore(): InMemoryMaintenanceRunStore | PostgresMaintenanceRunStore {
  return createStore<InMemoryMaintenanceRunStore | PostgresMaintenanceRunStore>(
    "MAINTENANCE_RUN_STORE",
    (databaseUrl) => new PostgresMaintenanceRunStore(databaseUrl),
    () => new InMemoryMaintenanceRunStore()
  );
}

export function createWatcherRegistryStore(): InMemoryWatcherRegistryStore | PostgresWatcherRegistryStore {
  return createStore<InMemoryWatcherRegistryStore | PostgresWatcherRegistryStore>(
    "WATCHER_REGISTRY_STORE",
    (databaseUrl) => new PostgresWatcherRegistryStore(databaseUrl),
    () => new InMemoryWatcherRegistryStore()
  );
}

export function createPrCrosslinkStore(): InMemoryPrCrosslinkStore | PostgresPrCrosslinkStore {
  return createStore<InMemoryPrCrosslinkStore | PostgresPrCrosslinkStore>(
    "PR_CROSSLINK_STORE",
    (databaseUrl) => new PostgresPrCrosslinkStore(databaseUrl),
    () => new InMemoryPrCrosslinkStore()
  );
}

// The snapshot is an on-disk artifact (the downloaded-data location), so there is
// no Postgres variant; unit tests swap in InMemorySnapshotStore via the test context.
export function createSnapshotStore(): SnapshotStore {
  return new FileSnapshotStore(snapshotRoot());
}
