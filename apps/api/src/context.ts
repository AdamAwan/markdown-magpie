import type { EmbeddingProvider } from "@magpie/core";
import { RuntimeConfigHolder } from "./config-holder.js";
import { logger } from "./logger.js";
import { BackgroundEmbedder } from "./platform/background-embedder.js";
import { BackgroundRunner } from "./platform/background-runner.js";
import {
  createGapClosureVerificationStore,
  createGapClusterStore,
  createPrCrosslinkStore,
  createProposalStore,
  createQuestionLogStore,
  createReconciliationDecisionStore,
  createMaintenanceRunStore,
  createPatrolStore,
  createScheduledTaskStore,
  createInsightsStore,
  createSeedPlanStore,
  createQuestionnaireStore,
  createSnapshotStore,
  createSourceMapStore,
  createSourceSyncStore,
  createWatcherRegistryStore,
  storeBackend
} from "./platform/stores.js";
import type { InsightsStore } from "./stores/insights-store.js";
import { createConfiguredEmbeddingProvider, embeddingModelId } from "./platform/providers.js";
import { createDbPool } from "./platform/db-pool.js";
import type { AppConfig } from "./platform/config.js";
import type pg from "pg";
import { InMemoryKnowledgeIndex } from "./stores/knowledge-index.js";
import { PostgresKnowledgeStore } from "./stores/postgres-knowledge-store.js";
import {
  type ConfiguredKnowledgeFlow,
  type ConfiguredKnowledgeRepository,
  type KnowledgeRoleGrants
} from "./stores/knowledge-repositories.js";
import { checkoutRoot, syncConfiguredGitCheckouts, type RepositoryDeps } from "./platform/repositories.js";
import type { JobBroker } from "./jobs/broker.js";
import { DEFAULT_PGBOSS_SCHEMA, PgBossJobBroker } from "./jobs/pg-boss-broker.js";
import { backfillGapClusters } from "./scheduling/gap-backfill.js";
import type { JobAcceptanceStore } from "./stores/job-acceptance-store.js";
import { PostgresJobAcceptanceStore } from "./stores/postgres-job-acceptance-store.js";
import type { RateLimitStore } from "./stores/rate-limit-store.js";
import { PostgresRateLimitStore } from "./stores/postgres-rate-limit-store.js";

export interface AppContext {
  stores: {
    knowledge: PostgresKnowledgeStore | undefined;
    knowledgeIndex: InMemoryKnowledgeIndex;
    questionLogs: ReturnType<typeof createQuestionLogStore>;
    proposals: ReturnType<typeof createProposalStore>;
    gapClosureVerifications: ReturnType<typeof createGapClosureVerificationStore>;
    scheduledTasks: ReturnType<typeof createScheduledTaskStore>;
    sourceSync: ReturnType<typeof createSourceSyncStore>;
    sourceMap: ReturnType<typeof createSourceMapStore>;
    seedPlans: ReturnType<typeof createSeedPlanStore>;
    questionnaires: ReturnType<typeof createQuestionnaireStore>;
    patrol: ReturnType<typeof createPatrolStore>;
    gapClusters: ReturnType<typeof createGapClusterStore>;
    reconciliations: ReturnType<typeof createReconciliationDecisionStore>;
    maintenanceRuns: ReturnType<typeof createMaintenanceRunStore>;
    prCrosslinks: ReturnType<typeof createPrCrosslinkStore>;
    snapshots: ReturnType<typeof createSnapshotStore>;
    watchers: ReturnType<typeof createWatcherRegistryStore>;
    insights: InsightsStore;
    jobAcceptances: JobAcceptanceStore;
    rateLimit: RateLimitStore;
  };
  jobs: JobBroker;
  // The single, process-wide Postgres pool shared by every Postgres-backed store
  // (see platform/db-pool.ts). Undefined when every store is in-memory (e.g. unit
  // tests) — readiness treats an absent pool as "no Postgres dependency to check".
  pool: pg.Pool | undefined;
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
    // Flow-scoped authorization grants (role -> flow -> capabilities), read from
    // KNOWLEDGE_ROLE_GRANTS. Empty leaves flow-scoping inactive.
    roleGrants: KnowledgeRoleGrants;
    checkoutRoot: string;
  };
  embedder: BackgroundEmbedder;
  background: BackgroundRunner;
  repositoryDeps(): RepositoryDeps;
  bootstrap(): Promise<void>;
}

export async function createAppContext(config: AppConfig): Promise<AppContext> {
  const databaseUrl = config.databaseUrl;
  // One shared, tuned pool for every Postgres-backed store. The job-acceptance
  // store is always Postgres-backed, so the pool is always created here.
  const pool = createDbPool(config);
  const knowledgeStore =
    storeBackend(config, "KNOWLEDGE_STORE") === "postgres"
      ? new PostgresKnowledgeStore(pool, embeddingModelId(config))
      : undefined;
  const embedding = knowledgeStore ? createConfiguredEmbeddingProvider(config) : undefined;
  const knowledgeIndex = knowledgeStore
    ? new InMemoryKnowledgeIndex(knowledgeStore, {
        // Keyword search runs in Postgres (full-text) whenever the store is present,
        // independent of embeddings; the vector side is only added when embeddings
        // are configured. Both fall back to the in-memory path on error.
        keywordSearch: knowledgeStore,
        ...(embedding ? { embeddingProvider: embedding, vectorSearch: knowledgeStore } : {}),
        onNotice: (message) => logger.warn({ notice: message }, "knowledge index notice")
      })
    : new InMemoryKnowledgeIndex();

  const knowledgeConfig = {
    sources: config.knowledge.sources,
    destinations: config.knowledge.destinations,
    repositories: config.knowledge.repositories,
    flows: config.knowledge.flows,
    roleGrants: config.knowledge.roleGrants,
    checkoutRoot: checkoutRoot(config)
  };

  const embedder = new BackgroundEmbedder(knowledgeStore, embedding);
  const background = new BackgroundRunner();

  // Single source of truth for the pg-boss schema shared by the broker (which
  // owns the job table) and the insights store (which reads it for the throughput
  // chart). No config override exists, so both use the default.
  const pgBossSchema = DEFAULT_PGBOSS_SCHEMA;
  const jobs: JobBroker = new PgBossJobBroker({
    connectionString: databaseUrl,
    // The shared process-wide pool; createIfAdmitted checks out a dedicated client
    // from it to hold the admission advisory lock. No new pool is created.
    pool,
    schema: pgBossSchema,
    scheduleTimezone: config.jobs.scheduleTimezone
  });

  const ctx: AppContext = {
    stores: {
      knowledge: knowledgeStore,
      knowledgeIndex,
      questionLogs: createQuestionLogStore(config, pool),
      proposals: createProposalStore(config, pool),
      gapClosureVerifications: createGapClosureVerificationStore(config, pool),
      scheduledTasks: createScheduledTaskStore(config, pool),
      sourceSync: createSourceSyncStore(config, pool),
      sourceMap: createSourceMapStore(config, pool),
      seedPlans: createSeedPlanStore(config, pool),
      questionnaires: createQuestionnaireStore(config, pool),
      patrol: createPatrolStore(config, pool),
      gapClusters: createGapClusterStore(config, pool),
      reconciliations: createReconciliationDecisionStore(config, pool),
      maintenanceRuns: createMaintenanceRunStore(config, pool),
      prCrosslinks: createPrCrosslinkStore(config, pool),
      snapshots: createSnapshotStore(config),
      watchers: createWatcherRegistryStore(config, pool),
      insights: createInsightsStore(pool, pgBossSchema),
      jobAcceptances: new PostgresJobAcceptanceStore(pool),
      rateLimit: new PostgresRateLimitStore(pool)
    },
    jobs,
    pool,
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
      // Adopt pre-versioning section vectors under the configured embedding
      // model before anything can trigger the background embedder — otherwise a
      // NULL stamp reads as a model mismatch and the whole corpus re-embeds.
      // Best-effort: an unreachable store surfaces on the required steps below.
      try {
        const adopted = await knowledgeStore?.adoptUnversionedEmbeddings();
        if (adopted) {
          logger.info({ adopted, embeddingModel: embeddingModelId(config) }, "adopted unversioned section embeddings");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        logger.error({ err: message }, "failed to adopt unversioned section embeddings");
      }
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
      // An embedding-model change invalidates the whole corpus's vectors at once,
      // and (unlike a content change) nothing re-indexes to notice it — so kick
      // the embedder here. A no-op pass when nothing is pending is one cheap query.
      void embedder.trigger();
    }
  };
  return ctx;
}
