import type { EmbeddingProvider } from "@magpie/core";
import { RuntimeConfigHolder } from "./config-holder.js";
import { logger } from "./logger.js";
import { BackgroundEmbedder } from "./platform/background-embedder.js";
import { BackgroundRunner } from "./platform/background-runner.js";
import {
  createGapClusterStore,
  createPrCrosslinkStore,
  createProposalStore,
  createQuestionLogStore,
  createReconciliationDecisionStore,
  createMaintenanceRunStore,
  createPatrolStore,
  createScheduledTaskStore,
  createSnapshotStore,
  createSourceSyncStore,
  createWatcherRegistryStore,
  storeBackend
} from "./platform/stores.js";
import { createConfiguredEmbeddingProvider } from "./platform/providers.js";
import type { AppConfig } from "./platform/config.js";
import { InMemoryKnowledgeIndex } from "./stores/knowledge-index.js";
import { PostgresKnowledgeStore } from "./stores/postgres-knowledge-store.js";
import {
  type ConfiguredKnowledgeFlow,
  type ConfiguredKnowledgeRepository
} from "./stores/knowledge-repositories.js";
import { checkoutRoot, syncConfiguredGitCheckouts, type RepositoryDeps } from "./platform/repositories.js";
import type { JobBroker } from "./jobs/broker.js";
import { PgBossJobBroker } from "./jobs/pg-boss-broker.js";
import { backfillGapClusters } from "./scheduling/gap-backfill.js";
import type { JobAcceptanceStore } from "./stores/job-acceptance-store.js";
import { PostgresJobAcceptanceStore } from "./stores/postgres-job-acceptance-store.js";

export interface AppContext {
  stores: {
    knowledge: PostgresKnowledgeStore | undefined;
    knowledgeIndex: InMemoryKnowledgeIndex;
    questionLogs: ReturnType<typeof createQuestionLogStore>;
    proposals: ReturnType<typeof createProposalStore>;
    scheduledTasks: ReturnType<typeof createScheduledTaskStore>;
    sourceSync: ReturnType<typeof createSourceSyncStore>;
    patrol: ReturnType<typeof createPatrolStore>;
    gapClusters: ReturnType<typeof createGapClusterStore>;
    reconciliations: ReturnType<typeof createReconciliationDecisionStore>;
    maintenanceRuns: ReturnType<typeof createMaintenanceRunStore>;
    prCrosslinks: ReturnType<typeof createPrCrosslinkStore>;
    snapshots: ReturnType<typeof createSnapshotStore>;
    watchers: ReturnType<typeof createWatcherRegistryStore>;
    jobAcceptances: JobAcceptanceStore;
  };
  jobs: JobBroker;
  providers: {
    embedding: EmbeddingProvider | undefined;
  };
  // Validated, env-derived static config, read once at startup.
  settings: AppConfig;
  config: RuntimeConfigHolder;
  knowledgeConfig: {
    sources: ConfiguredKnowledgeRepository[];
    destinations: ConfiguredKnowledgeRepository[];
    flows: ConfiguredKnowledgeFlow[];
    repositories: ConfiguredKnowledgeRepository[];
    checkoutRoot: string;
  };
  embedder: BackgroundEmbedder;
  background: BackgroundRunner;
  repositoryDeps(): RepositoryDeps;
  bootstrap(): Promise<void>;
}

export async function createAppContext(config: AppConfig): Promise<AppContext> {
  const databaseUrl = config.databaseUrl;
  const knowledgeStore =
    storeBackend(config, "KNOWLEDGE_STORE") === "postgres" ? new PostgresKnowledgeStore(databaseUrl) : undefined;
  const embedding = knowledgeStore ? createConfiguredEmbeddingProvider(config) : undefined;
  const knowledgeIndex = knowledgeStore
    ? new InMemoryKnowledgeIndex(
        knowledgeStore,
        embedding
          ? { embeddingProvider: embedding, vectorSearch: knowledgeStore, onNotice: (message) => logger.warn({ notice: message }, "knowledge index notice") }
          : {}
      )
    : new InMemoryKnowledgeIndex();

  const knowledgeConfig = {
    sources: config.knowledge.sources,
    destinations: config.knowledge.destinations,
    repositories: config.knowledge.repositories,
    flows: config.knowledge.flows,
    checkoutRoot: checkoutRoot(config)
  };

  const embedder = new BackgroundEmbedder(knowledgeStore, embedding);
  const background = new BackgroundRunner();

  const jobs: JobBroker = new PgBossJobBroker({
    connectionString: databaseUrl,
    scheduleTimezone: config.jobs.scheduleTimezone
  });

  const ctx: AppContext = {
    stores: {
      knowledge: knowledgeStore,
      knowledgeIndex,
      questionLogs: createQuestionLogStore(config),
      proposals: createProposalStore(config),
      scheduledTasks: createScheduledTaskStore(config),
      sourceSync: createSourceSyncStore(config),
      patrol: createPatrolStore(config),
      gapClusters: createGapClusterStore(config),
      reconciliations: createReconciliationDecisionStore(config),
      maintenanceRuns: createMaintenanceRunStore(config),
      prCrosslinks: createPrCrosslinkStore(config),
      snapshots: createSnapshotStore(config),
      watchers: createWatcherRegistryStore(config),
      jobAcceptances: new PostgresJobAcceptanceStore(databaseUrl)
    },
    jobs,
    providers: {
      embedding
    },
    settings: config,
    config: new RuntimeConfigHolder({ aiProvider: config.aiProvider }),
    knowledgeConfig,
    embedder,
    background,
    repositoryDeps() {
      return {
        knowledgeConfig,
        knowledgeIndex,
        triggerEmbedding: () => void embedder.trigger(),
        checkoutRoot: knowledgeConfig.checkoutRoot,
        localIndexRoot: config.paths.localIndexRoot
      };
    },
    async bootstrap() {
      // Syncing git checkouts is required: a failure here aborts startup (the
      // caller maps a throw to a non-zero exit). Hydrating the index is
      // best-effort — a fresh or unreachable store should not stop the server.
      await syncConfiguredGitCheckouts(this.repositoryDeps());
      try {
        await knowledgeIndex.hydrate();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        logger.error({ err: message }, "failed to hydrate knowledge index from storage");
      }
      // Best-effort one-shot migration: give pre-existing proposals a gap cluster
      // so the reconciler has lineage to work from. No-ops once clusters exist.
      try {
        await backfillGapClusters(this);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        logger.error({ err: message }, "failed to backfill gap clusters");
      }
    }
  };
  return ctx;
}
