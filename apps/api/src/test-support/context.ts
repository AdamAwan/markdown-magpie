import type { AppContext } from "../context.js";
import { RuntimeConfigHolder } from "../config-holder.js";
import { loadConfig } from "../platform/config.js";
import { BackgroundEmbedder } from "../platform/background-embedder.js";
import { BackgroundRunner } from "../platform/background-runner.js";
import { InMemoryGapClusterStore } from "../stores/gap-cluster-store.js";
import { InMemoryKnowledgeIndex } from "../stores/knowledge-index.js";
import { InMemoryProposalStore } from "../stores/proposal-store.js";
import { InMemoryGapClosureVerificationStore } from "../stores/gap-closure-verification-store.js";
import { InMemoryQuestionLogStore } from "../stores/question-log-store.js";
import { InMemoryPrCrosslinkStore } from "../stores/pr-crosslink-store.js";
import { InMemoryReconciliationDecisionStore } from "../stores/reconciliation-decision-store.js";
import { InMemoryMaintenanceRunStore } from "../stores/maintenance-run-store.js";
import { InMemoryScheduledTaskStore } from "../stores/scheduled-task-store.js";
import { FakeJobBroker } from "../jobs/fake-broker.js";
import { InMemoryPatrolStore } from "../stores/patrol-store.js";
import { InMemorySnapshotStore } from "../stores/snapshot-store.js";
import { InMemorySeedPlanStore } from "../stores/seed-plan-store.js";
import { InMemoryQuestionnaireStore } from "../stores/questionnaire-store.js";
import { InMemorySourceMapStore } from "../stores/source-map-store.js";
import { InMemorySourceSyncStore } from "../stores/source-sync-store.js";
import { InMemoryWatcherRegistryStore } from "../stores/watcher-registry-store.js";
import { NullInsightsStore } from "../stores/insights-store.js";
import { InMemoryJobAcceptanceStore } from "../stores/job-acceptance-store.js";
import { InMemoryJobRepairContextStore } from "../stores/job-repair-context-store.js";
import { InMemoryRateLimitStore } from "../stores/rate-limit-store.js";

// Builds an AppContext wired entirely to in-memory stores with fake collaborators,
// matching the real AppContext interface field-for-field. Pass overrides to
// swap in a specific store or provider for a test.
export function makeTestContext(overrides: Partial<AppContext> = {}): AppContext {
  const knowledgeIndex = new InMemoryKnowledgeIndex();
  const knowledgeConfig = {
    sources: [],
    destinations: [],
    flows: [],
    repositories: [],
    roleGrants: {},
    checkoutRoot: ".magpie/checkouts",
    ...overrides.knowledgeConfig
  };
  const settings = loadConfig({
    DATABASE_URL: "postgres://postgres:postgres@localhost:5432/markdown_magpie",
    AI_PROVIDER: "codex",
    // Auth fails closed by default; the in-memory test context explicitly opts
    // out so buildApp(makeTestContext()) exercises handlers without tokens.
    AUTH_REQUIRED: "false",
    // Bounded-waits (e.g. the reconciler's reshape job) resolve to a terminal job
    // instantly when a fake broker completes it synchronously; when a broker never
    // completes, keep the fallback wait tiny so tests don't block on the real
    // job-expiry deadline (5 min for reconcile_gap_clusters).
    JOB_RUN_TO_COMPLETION_TIMEOUT_MS: "100",
    JOB_WAIT_POLL_MS: "5"
  });
  const embedder = new BackgroundEmbedder(undefined, undefined);

  const base: AppContext = {
    stores: {
      knowledge: undefined,
      knowledgeIndex,
      questionLogs: new InMemoryQuestionLogStore(),
      proposals: new InMemoryProposalStore(),
      gapClosureVerifications: new InMemoryGapClosureVerificationStore(),
      scheduledTasks: new InMemoryScheduledTaskStore(),
      sourceSync: new InMemorySourceSyncStore(),
      sourceMap: new InMemorySourceMapStore(),
      seedPlans: new InMemorySeedPlanStore(),
      questionnaires: new InMemoryQuestionnaireStore(),
      patrol: new InMemoryPatrolStore(),
      gapClusters: new InMemoryGapClusterStore(),
      reconciliations: new InMemoryReconciliationDecisionStore(),
      maintenanceRuns: new InMemoryMaintenanceRunStore(),
      prCrosslinks: new InMemoryPrCrosslinkStore(),
      snapshots: new InMemorySnapshotStore(),
      watchers: new InMemoryWatcherRegistryStore(),
      insights: new NullInsightsStore(),
      jobAcceptances: new InMemoryJobAcceptanceStore(),
      jobRepairContexts: new InMemoryJobRepairContextStore(),
      rateLimit: new InMemoryRateLimitStore()
    },
    jobs: new FakeJobBroker(),
    pool: undefined,
    providers: {
      embedding: undefined
    },
    settings,
    config: new RuntimeConfigHolder({ aiProvider: "codex" }),
    knowledgeConfig,
    embedder,
    background: new BackgroundRunner(),
    repositoryDeps() {
      return {
        knowledgeConfig,
        knowledgeIndex,
        triggerEmbedding: () => {},
        checkoutRoot: knowledgeConfig.checkoutRoot,
        localIndexRoot: undefined
      };
    },
    async bootstrap() {
      // No-op for tests.
    }
  };

  // knowledgeConfig is merged with defaults above and shared with repositoryDeps, so
  // force the merged value to win over the raw (possibly partial) override.
  return { ...base, ...overrides, knowledgeConfig };
}
