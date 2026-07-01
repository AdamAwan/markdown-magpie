import { z } from "zod";
import { AI_PROVIDERS, isAiProviderName, type AiProviderName } from "@magpie/jobs";
import { authSettingsFromEnv, isAuthRequired } from "@magpie/auth";
import {
  getConfiguredKnowledgeDestinations,
  getConfiguredKnowledgeFlows,
  getConfiguredKnowledgeRepositories,
  getConfiguredKnowledgeSources,
  type ConfiguredKnowledgeFlow,
  type ConfiguredKnowledgeRepository
} from "../stores/knowledge-repositories.js";

type StoreBackend = "memory" | "postgres";

// The per-store backend overrides. Each defaults to STORAGE_BACKEND when unset.
const STORE_ENV_NAMES = [
  "KNOWLEDGE_STORE",
  "QUESTION_LOG_STORE",
  "PROPOSAL_STORE",
  "SCHEDULED_TASK_STORE",
  "SOURCE_SYNC_STORE",
  "PATROL_STORE",
  "GAP_CLUSTER_STORE",
  "RECONCILIATION_DECISION_STORE",
  "MAINTENANCE_RUN_STORE",
  "WATCHER_REGISTRY_STORE",
  "PR_CROSSLINK_STORE"
] as const;

export type StoreEnvName = (typeof STORE_ENV_NAMES)[number];

// The validated, env-derived static configuration for the API. Read and checked
// once at startup (see loadConfig); every composition-root reader consumes this
// instead of touching process.env, so misconfiguration fails fast at boot rather
// than lazily mid-request. This is distinct from RuntimeConfigHolder, which holds
// the runtime-mutable AI provider; aiProvider here only seeds that holder.
export interface AppConfig {
  databaseUrl: string;
  database: {
    poolMax: number;
    idleTimeoutMs: number;
    connectionTimeoutMs: number;
    statementTimeoutMs: number;
  };
  auth: {
    required: boolean;
    issuer: string;
    audience: string;
    jwksUri?: string;
  };
  port: number;
  cors: {
    // The Access-Control-Allow-Origin policy. "*" (the default) allows any
    // origin; an explicit list restricts responses to those origins only.
    allowedOrigins: "*" | string[];
  };
  nodeEnv: string;
  logStartupConfig: boolean;
  apiShutdownDrainMs: number;
  aiProvider: AiProviderName;
  storage: {
    default: StoreBackend;
    overrides: Partial<Record<StoreEnvName, StoreBackend>>;
  };
  embeddings: {
    openAiCompatible: {
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      embeddingBaseUrl?: string;
      embeddingApiKey?: string;
      embeddingModel?: string;
    };
    azureOpenAi: {
      endpoint?: string;
      apiKey?: string;
      chatDeployment?: string;
      embeddingDeployment?: string;
      apiVersion: string;
    };
    timeoutMs?: number;
  };
  knowledge: {
    sources: ConfiguredKnowledgeRepository[];
    destinations: ConfiguredKnowledgeRepository[];
    repositories: ConfiguredKnowledgeRepository[];
    flows: ConfiguredKnowledgeFlow[];
    repositoryPath?: string;
  };
  paths: {
    checkoutRoot: string;
    snapshotRoot: string;
    localIndexRoot?: string;
  };
  jobs: {
    waitTimeoutMs: number;
    waitPollMs: number;
    runToCompletionTimeoutMs?: number;
    scheduleTimezone: string;
  };
  watcher: {
    name?: string;
    pollIntervalMs?: number;
    activeWindowMs: number;
    agentApiTimeoutMs?: number;
  };
  git: {
    provider: string;
    githubToken?: string;
    azureDevopsPat?: string;
  };
}

// An unset var and an explicitly-empty one (a blank `FOO=` line, common in .env
// files) both mean "use the default", so collapse "" to undefined before any
// validation runs.
const emptyToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

// A required-when-present positive integer (e.g. "30000"); rejects non-numeric
// or non-positive input rather than silently falling back to a default.
const optionalPositiveInt = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .regex(/^\d+$/, "must be a positive integer")
    .transform((value) => Number.parseInt(value, 10))
    .refine((value) => value > 0, "must be greater than 0")
    .optional()
);

const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url("must be a valid URL").optional());
const optionalBackend = z.preprocess(emptyToUndefined, z.enum(["memory", "postgres"]).optional());

const storeOverridesSchema = z.object(
  Object.fromEntries(STORE_ENV_NAMES.map((name) => [name, optionalBackend])) as Record<
    StoreEnvName,
    typeof optionalBackend
  >
);

const schema = z
  .object({
    DATABASE_URL: z.preprocess(emptyToUndefined, z.string().url("must be a valid URL")),
    DB_POOL_MAX: optionalPositiveInt,
    DB_IDLE_TIMEOUT_MS: optionalPositiveInt,
    DB_CONNECTION_TIMEOUT_MS: optionalPositiveInt,
    DB_STATEMENT_TIMEOUT_MS: optionalPositiveInt,
    // Validated at field level (not in superRefine) so it is still reported when
    // other fields also fail — superRefine is skipped once base parsing errors.
    AI_PROVIDER: z.preprocess(
      emptyToUndefined,
      z.custom<AiProviderName>((value) => isAiProviderName(value), {
        message: `AI_PROVIDER must name a supported watcher provider (${AI_PROVIDERS.join(" | ")})`
      })
    ),
    PORT: optionalPositiveInt,
    CORS_ALLOWED_ORIGINS: optionalString,
    NODE_ENV: optionalString,
    LOG_STARTUP_CONFIG: optionalString,
    API_SHUTDOWN_DRAIN_MS: optionalPositiveInt,

    STORAGE_BACKEND: optionalBackend,

    OPENAI_COMPATIBLE_BASE_URL: optionalUrl,
    OPENAI_COMPATIBLE_API_KEY: optionalString,
    OPENAI_COMPATIBLE_MODEL: optionalString,
    OPENAI_COMPATIBLE_EMBEDDING_BASE_URL: optionalUrl,
    OPENAI_COMPATIBLE_EMBEDDING_API_KEY: optionalString,
    OPENAI_COMPATIBLE_EMBEDDING_MODEL: optionalString,
    AZURE_OPENAI_ENDPOINT: optionalUrl,
    AZURE_OPENAI_API_KEY: optionalString,
    AZURE_OPENAI_CHAT_DEPLOYMENT: optionalString,
    AZURE_OPENAI_EMBEDDING_DEPLOYMENT: optionalString,
    AZURE_OPENAI_API_VERSION: optionalString,
    EMBEDDING_TIMEOUT_MS: optionalPositiveInt,

    MAGPIE_CHECKOUT_ROOT: optionalString,
    MAGPIE_SNAPSHOT_ROOT: optionalString,
    MAGPIE_LOCAL_INDEX_ROOT: optionalString,
    KNOWLEDGE_REPO_PATH: optionalString,

    JOB_WAIT_TIMEOUT_MS: optionalPositiveInt,
    JOB_WAIT_POLL_MS: optionalPositiveInt,
    JOB_RUN_TO_COMPLETION_TIMEOUT_MS: optionalPositiveInt,
    JOB_SCHEDULE_TIMEZONE: optionalString,

    WATCHER_NAME: optionalString,
    WATCHER_POLL_INTERVAL_MS: optionalPositiveInt,
    WATCHER_ACTIVE_WINDOW_MS: optionalPositiveInt,
    AGENT_API_TIMEOUT_MS: optionalPositiveInt,

    GIT_PROVIDER: optionalString,
    GITHUB_TOKEN: optionalString,
    AZURE_DEVOPS_PAT: optionalString,

    AUTH_REQUIRED: optionalString,
    AUTH0_DOMAIN: optionalString,
    AUTH0_ISSUER_BASE_URL: optionalString,
    AUTH0_AUDIENCE: optionalString
  })
  .extend(storeOverridesSchema.shape)
  .superRefine((env, ctx) => {
    // Auth wiring lives in @magpie/auth; we only assert coherence here so a
    // misconfigured deployment fails at boot instead of on the first request.
    //
    // Auth fails CLOSED: it is required unless an operator EXPLICITLY opts out
    // with AUTH_REQUIRED=false. An unset/blank/typo'd value leaves auth on, so a
    // misconfiguration can never silently expose the whole API.
    if (!isAuthRequired(env.AUTH_REQUIRED)) {
      return;
    }
    if (env.AUTH0_AUDIENCE === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AUTH0_AUDIENCE"],
        message: "is required when auth is enabled (set AUTH_REQUIRED=false to disable auth)"
      });
    } else if (env.AUTH0_AUDIENCE === PLACEHOLDER_AUDIENCE) {
      // The committed example value is a stand-in, not a real Auth0 API
      // identifier; booting with it would accept tokens for a non-existent
      // audience, so reject it rather than start in an insecure state.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AUTH0_AUDIENCE"],
        message: `must be a real Auth0 API identifier, not the placeholder ${PLACEHOLDER_AUDIENCE} (set AUTH_REQUIRED=false to disable auth)`
      });
    }
    if (env.AUTH0_ISSUER_BASE_URL === undefined && env.AUTH0_DOMAIN === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AUTH0_ISSUER_BASE_URL"],
        message: "AUTH0_ISSUER_BASE_URL or AUTH0_DOMAIN is required when auth is enabled (set AUTH_REQUIRED=false to disable auth)"
      });
    }
  });

// The committed placeholder audience from .env.example. Real deployments must
// override it; it is rejected at boot when auth is enabled (see superRefine).
const PLACEHOLDER_AUDIENCE = "https://markdown-magpie.local/api";

// Parses CORS_ALLOWED_ORIGINS into the Access-Control-Allow-Origin policy.
// Unset, blank, or a literal "*" means allow any origin (the backwards-compatible
// default); a comma-separated list restricts responses to exactly those origins.
function parseAllowedOrigins(value: string | undefined): "*" | string[] {
  if (value === undefined || value.trim() === "*") {
    return "*";
  }
  const origins = value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return origins.length > 0 ? origins : "*";
}

// Reads and validates the API's environment once at startup, returning a typed
// config object. Throws a single aggregated Error naming every offending var on
// invalid/missing-required config. `env` is injectable so tests need not mutate
// process.env.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const name = issue.path.join(".") || "(root)";
      return `  - ${name}: ${issue.message}`;
    });
    throw new Error(`Invalid API configuration:\n${lines.join("\n")}`);
  }

  const parsed = result.data;

  const overrides: Partial<Record<StoreEnvName, StoreBackend>> = {};
  for (const name of STORE_ENV_NAMES) {
    const value = parsed[name];
    if (value !== undefined) {
      overrides[name] = value;
    }
  }

  const sources = getConfiguredKnowledgeSources(env);
  const destinations = getConfiguredKnowledgeDestinations(env);

  return {
    databaseUrl: parsed.DATABASE_URL,
    database: {
      poolMax: parsed.DB_POOL_MAX ?? 10,
      idleTimeoutMs: parsed.DB_IDLE_TIMEOUT_MS ?? 30_000,
      connectionTimeoutMs: parsed.DB_CONNECTION_TIMEOUT_MS ?? 10_000,
      statementTimeoutMs: parsed.DB_STATEMENT_TIMEOUT_MS ?? 30_000
    },
    // Single source of truth for auth wiring: required is fail-closed, and the
    // issuer/audience/jwks are resolved from the same env @magpie/auth uses so
    // buildApp never has to re-read process.env (which kept tests and config in
    // disagreement). superRefine above already proved this coheres when enabled.
    auth: authSettingsFromEnv(env),
    port: parsed.PORT ?? 4000,
    cors: {
      allowedOrigins: parseAllowedOrigins(parsed.CORS_ALLOWED_ORIGINS)
    },
    nodeEnv: parsed.NODE_ENV ?? "development",
    logStartupConfig: parsed.LOG_STARTUP_CONFIG !== "false",
    apiShutdownDrainMs: parsed.API_SHUTDOWN_DRAIN_MS ?? 10_000,
    aiProvider: parsed.AI_PROVIDER as AiProviderName,
    storage: {
      default: parsed.STORAGE_BACKEND ?? "memory",
      overrides
    },
    embeddings: {
      openAiCompatible: {
        baseUrl: parsed.OPENAI_COMPATIBLE_BASE_URL,
        apiKey: parsed.OPENAI_COMPATIBLE_API_KEY,
        model: parsed.OPENAI_COMPATIBLE_MODEL,
        embeddingBaseUrl: parsed.OPENAI_COMPATIBLE_EMBEDDING_BASE_URL,
        embeddingApiKey: parsed.OPENAI_COMPATIBLE_EMBEDDING_API_KEY,
        embeddingModel: parsed.OPENAI_COMPATIBLE_EMBEDDING_MODEL
      },
      azureOpenAi: {
        endpoint: parsed.AZURE_OPENAI_ENDPOINT,
        apiKey: parsed.AZURE_OPENAI_API_KEY,
        chatDeployment: parsed.AZURE_OPENAI_CHAT_DEPLOYMENT,
        embeddingDeployment: parsed.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
        apiVersion: parsed.AZURE_OPENAI_API_VERSION ?? "2024-10-21"
      },
      timeoutMs: parsed.EMBEDDING_TIMEOUT_MS
    },
    knowledge: {
      sources,
      destinations,
      repositories: getConfiguredKnowledgeRepositories(env),
      flows: getConfiguredKnowledgeFlows(env, sources, destinations),
      repositoryPath: parsed.KNOWLEDGE_REPO_PATH
    },
    paths: {
      checkoutRoot: parsed.MAGPIE_CHECKOUT_ROOT ?? ".magpie/checkouts",
      snapshotRoot: parsed.MAGPIE_SNAPSHOT_ROOT ?? ".magpie/snapshots",
      localIndexRoot: parsed.MAGPIE_LOCAL_INDEX_ROOT
    },
    jobs: {
      waitTimeoutMs: parsed.JOB_WAIT_TIMEOUT_MS ?? 25_000,
      waitPollMs: parsed.JOB_WAIT_POLL_MS ?? 250,
      runToCompletionTimeoutMs: parsed.JOB_RUN_TO_COMPLETION_TIMEOUT_MS,
      scheduleTimezone: parsed.JOB_SCHEDULE_TIMEZONE ?? "UTC"
    },
    watcher: {
      name: parsed.WATCHER_NAME,
      pollIntervalMs: parsed.WATCHER_POLL_INTERVAL_MS,
      activeWindowMs: parsed.WATCHER_ACTIVE_WINDOW_MS ?? 15 * 60 * 1000,
      agentApiTimeoutMs: parsed.AGENT_API_TIMEOUT_MS
    },
    git: {
      provider: parsed.GIT_PROVIDER ?? "local",
      githubToken: parsed.GITHUB_TOKEN,
      azureDevopsPat: parsed.AZURE_DEVOPS_PAT
    }
  };
}
