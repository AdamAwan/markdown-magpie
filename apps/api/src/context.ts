import type { ChatProvider, EmbeddingProvider } from "@magpie/core";
import { RuntimeConfigHolder } from "./config-holder.js";
import { BackgroundEmbedder } from "./platform/background-embedder.js";
import {
  createCrunchStore,
  createProposalStore,
  createQuestionLogStore,
  createScheduledTaskStore,
  requireDatabaseUrl,
  storeBackend
} from "./platform/stores.js";
import {
  type AiProviderName,
  createConfiguredChatProvider,
  createConfiguredEmbeddingProvider
} from "./platform/providers.js";
import { InMemoryKnowledgeIndex } from "./stores/knowledge-index.js";
import { PostgresKnowledgeStore } from "./stores/postgres-knowledge-store.js";
import {
  type ConfiguredKnowledgeFlow,
  type ConfiguredKnowledgeRepository,
  getConfiguredKnowledgeDestinations,
  getConfiguredKnowledgeFlows,
  getConfiguredKnowledgeRepositories,
  getConfiguredKnowledgeSources
} from "./stores/knowledge-repositories.js";
import { checkoutRoot, syncConfiguredGitCheckouts, type RepositoryDeps } from "./platform/repositories.js";
import type { JobBroker } from "./jobs/broker.js";
import { FakeJobBroker } from "./jobs/fake-broker.js";

export interface AppContext {
  stores: {
    knowledge: PostgresKnowledgeStore | undefined;
    knowledgeIndex: InMemoryKnowledgeIndex;
    questionLogs: ReturnType<typeof createQuestionLogStore>;
    proposals: ReturnType<typeof createProposalStore>;
    crunchRuns: ReturnType<typeof createCrunchStore>;
    scheduledTasks: ReturnType<typeof createScheduledTaskStore>;
  };
  jobs: JobBroker;
  providers: {
    chat: (provider: AiProviderName) => ChatProvider;
    embedding: EmbeddingProvider | undefined;
  };
  config: RuntimeConfigHolder;
  knowledgeConfig: {
    sources: ConfiguredKnowledgeRepository[];
    destinations: ConfiguredKnowledgeRepository[];
    flows: ConfiguredKnowledgeFlow[];
    repositories: ConfiguredKnowledgeRepository[];
    checkoutRoot: string;
  };
  embedder: BackgroundEmbedder;
  repositoryDeps(): RepositoryDeps;
  bootstrap(): Promise<void>;
}

export async function createAppContext(): Promise<AppContext> {
  const knowledgeStore =
    storeBackend("KNOWLEDGE_STORE") === "postgres" ? new PostgresKnowledgeStore(requireDatabaseUrl()) : undefined;
  const embedding = knowledgeStore ? createConfiguredEmbeddingProvider() : undefined;
  const knowledgeIndex = knowledgeStore
    ? new InMemoryKnowledgeIndex(
        knowledgeStore,
        embedding
          ? { embeddingProvider: embedding, vectorSearch: knowledgeStore, onNotice: (message) => console.warn(message) }
          : {}
      )
    : new InMemoryKnowledgeIndex();

  const sources = getConfiguredKnowledgeSources();
  const destinations = getConfiguredKnowledgeDestinations();
  const knowledgeConfig = {
    sources,
    destinations,
    repositories: getConfiguredKnowledgeRepositories(),
    flows: getConfiguredKnowledgeFlows(process.env, sources, destinations),
    checkoutRoot: checkoutRoot()
  };

  const embedder = new BackgroundEmbedder(knowledgeStore, embedding);

  // TODO(Task 3): replace with PgBossJobBroker (mandatory Postgres)
  const jobs: JobBroker = new FakeJobBroker();

  const ctx: AppContext = {
    stores: {
      knowledge: knowledgeStore,
      knowledgeIndex,
      questionLogs: createQuestionLogStore(),
      proposals: createProposalStore(),
      crunchRuns: createCrunchStore(),
      scheduledTasks: createScheduledTaskStore()
    },
    jobs,
    providers: {
      chat: (provider) => createConfiguredChatProvider(provider),
      embedding
    },
    config: RuntimeConfigHolder.fromEnv(),
    knowledgeConfig,
    embedder,
    repositoryDeps() {
      return { knowledgeConfig, knowledgeIndex, triggerEmbedding: () => void embedder.trigger() };
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
        console.error(`Failed to hydrate knowledge index from storage: ${message}`);
      }
    }
  };
  return ctx;
}
