import type { ChatProvider, ChatRequest, ChatResponse } from "@magpie/core";
import type { AppContext } from "../context.js";
import { RuntimeConfigHolder } from "../config-holder.js";
import { BackgroundEmbedder } from "../platform/background-embedder.js";
import { BackgroundRunner } from "../platform/background-runner.js";
import { DEFAULT_AI_JOB_CLAIM_TIMEOUT_MS, InMemoryAiJobQueue } from "../stores/ai-job-queue.js";
import { InMemoryCrunchStore } from "../stores/crunch-store.js";
import { InMemoryGapClusterStore } from "../stores/gap-cluster-store.js";
import { InMemoryKnowledgeIndex } from "../stores/knowledge-index.js";
import { InMemoryProposalStore } from "../stores/proposal-store.js";
import { InMemoryQuestionLogStore } from "../stores/question-log-store.js";
import { InMemoryScheduledTaskStore } from "../stores/scheduled-task-store.js";
import { InMemorySourceSyncStore } from "../stores/source-sync-store.js";

// A fully-typed ChatProvider stub — no casts. It returns a valid markdown
// proposal JSON payload so any direct provider path that does reach the chat
// model (e.g. a non-mock direct draft) parses cleanly. The mock-provider and
// empty-index code paths used by these tests never actually call complete(),
// but the stub keeps the AppContext.providers.chat contract honest.
function stubChat(): ChatProvider {
  return {
    async complete(_request: ChatRequest): Promise<ChatResponse> {
      return {
        content: '{"title":"T","targetPath":"t.md","markdown":"# T\\nbody","rationale":"r"}'
      };
    }
  };
}

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
      aiJobs: new InMemoryAiJobQueue(),
      gapClusters: new InMemoryGapClusterStore()
    },
    providers: {
      chat: () => stubChat(),
      embedding: undefined
    },
    config: new RuntimeConfigHolder({ aiExecutionMode: "direct", aiProvider: "mock" }),
    knowledgeConfig,
    embedder,
    background: new BackgroundRunner(),
    claimTimeoutMs: DEFAULT_AI_JOB_CLAIM_TIMEOUT_MS,
    repositoryDeps() {
      return { knowledgeConfig, knowledgeIndex, triggerEmbedding: () => {} };
    },
    async bootstrap() {
      // No-op for tests.
    }
  };

  return { ...base, ...overrides };
}
