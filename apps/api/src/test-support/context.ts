import type { AppContext } from "../context.js";
import { RuntimeConfigHolder } from "../config-holder.js";
import { BackgroundEmbedder } from "../platform/background-embedder.js";
import { BackgroundRunner } from "../platform/background-runner.js";
import { InMemoryCrunchStore } from "../stores/crunch-store.js";
import { InMemoryGapClusterStore } from "../stores/gap-cluster-store.js";
import { InMemoryKnowledgeIndex } from "../stores/knowledge-index.js";
import { InMemoryProposalStore } from "../stores/proposal-store.js";
import { InMemoryQuestionLogStore } from "../stores/question-log-store.js";
import { InMemoryReconciliationDecisionStore } from "../stores/reconciliation-decision-store.js";
import { InMemoryScheduledTaskStore } from "../stores/scheduled-task-store.js";
import type { JobBroker } from "../jobs/broker.js";
import { FakeJobBroker } from "../jobs/fake-broker.js";
import { InMemorySnapshotStore } from "../stores/snapshot-store.js";
import { InMemorySourceSyncStore } from "../stores/source-sync-store.js";

// Builds an AppContext wired entirely to in-memory stores in direct/mock mode,
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
  const embedder = new BackgroundEmbedder(undefined, undefined);

  const base: AppContext = {
    stores: {
      knowledge: undefined,
      knowledgeIndex,
      questionLogs: new InMemoryQuestionLogStore(),
      proposals: new InMemoryProposalStore(),
      crunchRuns: new InMemoryCrunchStore(),
      scheduledTasks: new InMemoryScheduledTaskStore(),
      sourceSync: new InMemorySourceSyncStore(),
      gapClusters: new InMemoryGapClusterStore(),
      reconciliations: new InMemoryReconciliationDecisionStore(),
      snapshots: new InMemorySnapshotStore()
    },
    jobs: new FakeJobBroker(),
    providers: {
      embedding: undefined
    },
    config: new RuntimeConfigHolder({ aiProvider: "codex" }),
    knowledgeConfig,
    embedder,
    background: new BackgroundRunner(),
    repositoryDeps() {
      return { knowledgeConfig, knowledgeIndex, triggerEmbedding: () => {} };
    },
    async bootstrap() {
      // No-op for tests.
    }
  };

  return { ...base, ...overrides };
}

// Convenience: build a test context with a pre-supplied jobs broker override.
export function makeTestContextWithJobs(jobs: JobBroker, other: Partial<AppContext> = {}): AppContext {
  return makeTestContext({ ...other, jobs });
}
