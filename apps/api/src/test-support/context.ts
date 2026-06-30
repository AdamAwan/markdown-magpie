import type { AppContext } from "../context.js";
import { RuntimeConfigHolder } from "../config-holder.js";
import { loadConfig } from "../platform/config.js";
import { BackgroundEmbedder } from "../platform/background-embedder.js";
import { BackgroundRunner } from "../platform/background-runner.js";
import { InMemoryGapClusterStore } from "../stores/gap-cluster-store.js";
import { InMemoryKnowledgeIndex } from "../stores/knowledge-index.js";
import { InMemoryProposalStore } from "../stores/proposal-store.js";
import { InMemoryQuestionLogStore } from "../stores/question-log-store.js";
import { InMemoryPrCrosslinkStore } from "../stores/pr-crosslink-store.js";
import { InMemoryReconciliationDecisionStore } from "../stores/reconciliation-decision-store.js";
import { InMemoryMaintenanceRunStore } from "../stores/maintenance-run-store.js";
import { InMemoryScheduledTaskStore } from "../stores/scheduled-task-store.js";
import { FakeJobBroker } from "../jobs/fake-broker.js";
import { InMemoryPatrolStore } from "../stores/patrol-store.js";
import { InMemorySnapshotStore } from "../stores/snapshot-store.js";
import { InMemorySourceSyncStore } from "../stores/source-sync-store.js";
import { InMemoryWatcherRegistryStore } from "../stores/watcher-registry-store.js";
import { InMemoryJobAcceptanceStore } from "../stores/job-acceptance-store.js";

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
    checkoutRoot: ".magpie/checkouts"
  };
  const settings = loadConfig({
    DATABASE_URL: "postgres://postgres:postgres@localhost:5432/markdown_magpie",
    AI_PROVIDER: "codex"
  });
  const embedder = new BackgroundEmbedder(undefined, undefined);

  const base: AppContext = {
    stores: {
      knowledge: undefined,
      knowledgeIndex,
      questionLogs: new InMemoryQuestionLogStore(),
      proposals: new InMemoryProposalStore(),
      scheduledTasks: new InMemoryScheduledTaskStore(),
      sourceSync: new InMemorySourceSyncStore(),
      patrol: new InMemoryPatrolStore(),
      gapClusters: new InMemoryGapClusterStore(),
      reconciliations: new InMemoryReconciliationDecisionStore(),
      maintenanceRuns: new InMemoryMaintenanceRunStore(),
      prCrosslinks: new InMemoryPrCrosslinkStore(),
      snapshots: new InMemorySnapshotStore(),
      watchers: new InMemoryWatcherRegistryStore(),
      jobAcceptances: new InMemoryJobAcceptanceStore()
    },
    jobs: new FakeJobBroker(),
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

  return { ...base, ...overrides };
}
