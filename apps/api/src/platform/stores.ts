import { DEFAULT_AI_JOB_CLAIM_TIMEOUT_MS, InMemoryAiJobQueue } from "../stores/ai-job-queue.js";
import { InMemoryCrunchStore } from "../stores/crunch-store.js";
import { InMemoryGapClusterStore } from "../stores/gap-cluster-store.js";
import { PostgresAiJobQueue } from "../stores/postgres-ai-job-queue.js";
import { PostgresCrunchStore } from "../stores/postgres-crunch-store.js";
import { PostgresGapClusterStore } from "../stores/postgres-gap-cluster-store.js";
import { PostgresProposalStore } from "../stores/postgres-proposal-store.js";
import { PostgresQuestionLogStore } from "../stores/postgres-question-log-store.js";
import { PostgresReconciliationDecisionStore } from "../stores/postgres-reconciliation-decision-store.js";
import { PostgresScheduledTaskStore } from "../stores/postgres-scheduled-task-store.js";
import { PostgresSourceSyncStore } from "../stores/postgres-source-sync-store.js";
import { InMemoryProposalStore } from "../stores/proposal-store.js";
import { InMemoryQuestionLogStore } from "../stores/question-log-store.js";
import { InMemoryReconciliationDecisionStore } from "../stores/reconciliation-decision-store.js";
import { InMemoryScheduledTaskStore } from "../stores/scheduled-task-store.js";
import { InMemorySourceSyncStore } from "../stores/source-sync-store.js";
import { FileSnapshotStore, type SnapshotStore } from "../stores/snapshot-store.js";
import { snapshotRoot } from "./repositories.js";

export function storageBackend(): "memory" | "postgres" {
  return process.env.STORAGE_BACKEND === "postgres" ? "postgres" : "memory";
}

export type StoreEnvName =
  | "KNOWLEDGE_STORE"
  | "QUESTION_LOG_STORE"
  | "PROPOSAL_STORE"
  | "AI_JOB_QUEUE"
  | "CRUNCH_STORE"
  | "SCHEDULED_TASK_STORE"
  | "SOURCE_SYNC_STORE"
  | "GAP_CLUSTER_STORE"
  | "RECONCILIATION_DECISION_STORE";

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
    throw new Error("DATABASE_URL is required when KNOWLEDGE_STORE=postgres");
  }
  return databaseUrl;
}

export function parseClaimTimeoutMs(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_AI_JOB_CLAIM_TIMEOUT_MS;
  }

  return parsed;
}

export function createAiJobQueue(claimTimeoutMs: number): InMemoryAiJobQueue | PostgresAiJobQueue {
  return createStore<InMemoryAiJobQueue | PostgresAiJobQueue>(
    "AI_JOB_QUEUE",
    (databaseUrl) => new PostgresAiJobQueue(databaseUrl, claimTimeoutMs),
    () => new InMemoryAiJobQueue(claimTimeoutMs)
  );
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

export function createCrunchStore(): InMemoryCrunchStore | PostgresCrunchStore {
  return createStore<InMemoryCrunchStore | PostgresCrunchStore>(
    "CRUNCH_STORE",
    (databaseUrl) => new PostgresCrunchStore(databaseUrl),
    () => new InMemoryCrunchStore()
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

// The snapshot is an on-disk artifact (the downloaded-data location), so there is
// no Postgres variant; unit tests swap in InMemorySnapshotStore via the test context.
export function createSnapshotStore(): SnapshotStore {
  return new FileSnapshotStore(snapshotRoot());
}
