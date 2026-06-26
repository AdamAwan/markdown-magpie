import type { AppContext } from "../../context.js";
import { reconcileSchedules } from "../../jobs/schedule-reconciler.js";
import { seedConfiguredKnowledge } from "../../platform/repositories.js";
import { storageBackend, storeBackend } from "../../platform/stores.js";
import { embeddingProviderName, getConfiguredAiProviders, retrievalMode } from "../../platform/providers.js";

const port = Number.parseInt(process.env.PORT ?? "4000", 10);

export function getRuntimeConfig(ctx: AppContext) {
  const availableProviders = getConfiguredAiProviders();
  return {
    api: {
      port,
      aiProvider: ctx.config.get().aiProvider,
      nodeEnv: process.env.NODE_ENV ?? "development"
    },
    stores: {
      storageBackend: storageBackend(),
      knowledgeStore: storeBackend("KNOWLEDGE_STORE"),
      questionLogStore: storeBackend("QUESTION_LOG_STORE"),
      proposalStore: storeBackend("PROPOSAL_STORE"),
      databaseUrl: maskConnectionString(process.env.DATABASE_URL)
    },
    knowledge: {
      repositoryPath: process.env.KNOWLEDGE_REPO_PATH ?? null,
      repositories: ctx.knowledgeConfig.repositories,
      sources: ctx.knowledgeConfig.sources,
      destinations: ctx.knowledgeConfig.destinations,
      flows: ctx.knowledgeConfig.flows,
      checkoutRoot: ctx.knowledgeConfig.checkoutRoot
    },
    providers: {
      llmProvider: ctx.config.get().aiProvider,
      embeddingProvider: embeddingProviderName() ?? "none",
      gitProvider: process.env.GIT_PROVIDER ?? "local",
      openAiCompatible: {
        baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL || null,
        model: process.env.OPENAI_COMPATIBLE_MODEL || null,
        apiKey: secretState(process.env.OPENAI_COMPATIBLE_API_KEY),
        embeddingBaseUrl: process.env.OPENAI_COMPATIBLE_EMBEDDING_BASE_URL || null,
        embeddingModel: process.env.OPENAI_COMPATIBLE_EMBEDDING_MODEL || null,
        embeddingApiKey: secretState(process.env.OPENAI_COMPATIBLE_EMBEDDING_API_KEY)
      },
      azureOpenAi: {
        endpoint: process.env.AZURE_OPENAI_ENDPOINT || null,
        chatDeployment: process.env.AZURE_OPENAI_CHAT_DEPLOYMENT || null,
        embeddingDeployment: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || null,
        apiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-10-21",
        apiKey: secretState(process.env.AZURE_OPENAI_API_KEY)
      },
      gitSecrets: {
        githubToken: secretState(process.env.GITHUB_TOKEN),
        azureDevopsPat: secretState(process.env.AZURE_DEVOPS_PAT)
      }
    },
    aiRuntime: {
      provider: ctx.config.get().aiProvider,
      providers: availableProviders
    },
    retrieval: (() => {
      const { mode, reason } = retrievalMode();
      return {
        mode,
        reason,
        embeddingProvider: embeddingProviderName() ?? null
      };
    })(),
    watcher: {
      name: process.env.WATCHER_NAME ?? null,
      pollIntervalMs: process.env.WATCHER_POLL_INTERVAL_MS ?? null,
      aiJobProvider: ctx.config.get().aiProvider,
      agentApiTimeoutMs: process.env.AGENT_API_TIMEOUT_MS ?? null
    }
  };
}

// Startup summary so operators can trace which options resolved and which
// providers/credentials are (not) wired up. Built from getRuntimeConfig() so it
// reuses the same secret masking — values are reported as "set"/"not set", never
// printed. Set LOG_STARTUP_CONFIG=false to suppress.
export function logStartupConfig(ctx: AppContext): void {
  if (process.env.LOG_STARTUP_CONFIG === "false") {
    return;
  }

  const cfg = getRuntimeConfig(ctx);
  const lines: string[] = [];
  const section = (title: string) => lines.push(`  ${title}`);
  const add = (label: string, value: unknown) => lines.push(`    ${`${label}`.padEnd(26)}: ${value}`);

  section("Stores (memory | postgres)");
  add("storage backend (default)", cfg.stores.storageBackend);
  add("knowledge store", cfg.stores.knowledgeStore);
  add("question log store", cfg.stores.questionLogStore);
  add("proposal store", cfg.stores.proposalStore);
  add("database url", cfg.stores.databaseUrl ?? "not set");

  section("AI execution (queue-only; watchers run all AI)");
  add("active provider", cfg.aiRuntime.provider);
  add("selectable providers", cfg.aiRuntime.providers.map((provider) => provider.name).join(", "));

  section("Chat provider (openai-compatible)");
  add("base url", cfg.providers.openAiCompatible.baseUrl ?? "not set");
  add("model", cfg.providers.openAiCompatible.model ?? "not set");
  add("api key", cfg.providers.openAiCompatible.apiKey);

  section("Embeddings / retrieval");
  add("retrieval mode", `${cfg.retrieval.mode} (${cfg.retrieval.reason})`);
  add("embedding provider", cfg.retrieval.embeddingProvider ?? "none");
  add("embedding base url", cfg.providers.openAiCompatible.embeddingBaseUrl ?? "falls back to chat");
  add("embedding model", cfg.providers.openAiCompatible.embeddingModel ?? "not set");
  add("embedding api key", cfg.providers.openAiCompatible.embeddingApiKey);

  section("Azure OpenAI");
  add("endpoint", cfg.providers.azureOpenAi.endpoint ?? "not set");
  add("chat deployment", cfg.providers.azureOpenAi.chatDeployment ?? "not set");
  add("embedding deployment", cfg.providers.azureOpenAi.embeddingDeployment ?? "not set");
  add("api key", cfg.providers.azureOpenAi.apiKey);

  section("Git");
  add("provider (display only)", cfg.providers.gitProvider);
  add("github token", cfg.providers.gitSecrets.githubToken);
  add("azure devops pat", cfg.providers.gitSecrets.azureDevopsPat);

  section("Knowledge");
  add("sources", cfg.knowledge.sources.map((repo) => `${repo.id}[${repo.kind}]`).join(", ") || "none");
  add("destinations", cfg.knowledge.destinations.map((repo) => `${repo.id}[${repo.kind}]`).join(", ") || "none");
  add(
    "flows",
    cfg.knowledge.flows.map((flow) => `${flow.id}(${flow.sourceIds.join("+")}->${flow.destinationId})`).join(", ") ||
      "none"
  );
  add("checkout root", cfg.knowledge.checkoutRoot);

  section("Watcher");
  add("name", cfg.watcher.name ?? "not set");
  add("poll interval ms", cfg.watcher.pollIntervalMs ?? "default (2000)");

  console.log(`Resolved configuration (env=${cfg.api.nodeEnv}):\n${lines.join("\n")}`);
}

// Clears all user-generated state then rebuilds the configured knowledge bases.
// Stores are cleared first, so even if re-seeding fails the app is left in a
// clean (empty) but recoverable state.
export async function resetData(ctx: AppContext) {
  await ctx.stores.questionLogs.reset();
  await ctx.stores.proposals.reset();
  await ctx.stores.scheduledTasks.reset();
  await ctx.stores.sourceSync.reset();
  await ctx.stores.patrol.reset();
  await ctx.stores.jobAcceptances.reset();

  // Clear the durable job queue (pg-boss owns all jobs/schedules now), then
  // reconcile schedules so the now-empty scheduled-task settings leave no
  // orphaned pg-boss schedule rows behind.
  await ctx.jobs.reset();
  await reconcileSchedules(ctx);

  if (ctx.stores.knowledge) {
    await ctx.stores.knowledge.reset();
  }
  ctx.stores.knowledgeIndex.reset();

  // Reset runtime AI config back to the .env-derived defaults.
  ctx.config.reset();

  // Rebuild the knowledge bases from configuration.
  const seed = await seedConfiguredKnowledge(ctx.repositoryDeps());

  return {
    reindexed: seed.indexed,
    failures: seed.failures,
    stats: ctx.stores.knowledgeIndex.getStats()
  };
}

function maskConnectionString(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    if (url.password) {
      url.password = "****";
    }
    if (url.username) {
      url.username = `${url.username.slice(0, 1)}***`;
    }
    return url.toString();
  } catch {
    return secretState(value);
  }
}

function secretState(value: string | undefined): "set" | "not set" {
  return value ? "set" : "not set";
}
