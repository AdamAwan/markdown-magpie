import { DEFAULT_AI_JOB_CLAIM_TIMEOUT_MS, InMemoryAiJobQueue } from "../stores/ai-job-queue.js";
import { InMemoryCrunchStore } from "../stores/crunch-store.js";
import { PostgresAiJobQueue } from "../stores/postgres-ai-job-queue.js";
import { PostgresCrunchStore } from "../stores/postgres-crunch-store.js";
import { PostgresProposalStore } from "../stores/postgres-proposal-store.js";
import { PostgresQuestionLogStore } from "../stores/postgres-question-log-store.js";
import { PostgresScheduledTaskStore } from "../stores/postgres-scheduled-task-store.js";
import { PostgresSourceSyncStore } from "../stores/postgres-source-sync-store.js";
import { InMemoryProposalStore } from "../stores/proposal-store.js";
import { InMemoryQuestionLogStore } from "../stores/question-log-store.js";
import { InMemoryScheduledTaskStore } from "../stores/scheduled-task-store.js";
import { InMemorySourceSyncStore } from "../stores/source-sync-store.js";

export function storageBackend(): "memory" | "postgres" {
  return process.env.STORAGE_BACKEND === "postgres" ? "postgres" : "memory";
}

export function storeBackend(
  name:
    | "KNOWLEDGE_STORE"
    | "QUESTION_LOG_STORE"
    | "PROPOSAL_STORE"
    | "AI_JOB_QUEUE"
    | "CRUNCH_STORE"
    | "SCHEDULED_TASK_STORE"
    | "SOURCE_SYNC_STORE"
): "memory" | "postgres" {
  return process.env[name] === "postgres" ? "postgres" : storageBackend();
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
  if (storeBackend("AI_JOB_QUEUE") === "postgres") {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required when AI_JOB_QUEUE=postgres");
    }

    return new PostgresAiJobQueue(databaseUrl, claimTimeoutMs);
  }

  return new InMemoryAiJobQueue(claimTimeoutMs);
}

export function createQuestionLogStore(): InMemoryQuestionLogStore | PostgresQuestionLogStore {
  if (storeBackend("QUESTION_LOG_STORE") === "postgres") {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required when QUESTION_LOG_STORE=postgres");
    }

    return new PostgresQuestionLogStore(databaseUrl);
  }

  return new InMemoryQuestionLogStore();
}

export function createProposalStore(): InMemoryProposalStore | PostgresProposalStore {
  if (storeBackend("PROPOSAL_STORE") === "postgres") {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required when PROPOSAL_STORE=postgres");
    }

    return new PostgresProposalStore(databaseUrl);
  }

  return new InMemoryProposalStore();
}

export function createCrunchStore(): InMemoryCrunchStore | PostgresCrunchStore {
  if (storeBackend("CRUNCH_STORE") === "postgres") {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required when CRUNCH_STORE=postgres");
    }

    return new PostgresCrunchStore(databaseUrl);
  }

  return new InMemoryCrunchStore();
}

export function createScheduledTaskStore(): InMemoryScheduledTaskStore | PostgresScheduledTaskStore {
  if (storeBackend("SCHEDULED_TASK_STORE") === "postgres") {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required when SCHEDULED_TASK_STORE=postgres");
    }

    return new PostgresScheduledTaskStore(databaseUrl);
  }

  return new InMemoryScheduledTaskStore();
}

export function createSourceSyncStore(): InMemorySourceSyncStore | PostgresSourceSyncStore {
  if (storeBackend("SOURCE_SYNC_STORE") === "postgres") {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required when SOURCE_SYNC_STORE=postgres");
    }

    return new PostgresSourceSyncStore(databaseUrl);
  }

  return new InMemorySourceSyncStore();
}
