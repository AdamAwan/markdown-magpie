import { z } from "zod";
import {
  AI_PROVIDERS,
  isAiProviderName,
  undeclaredOutputFieldPolicyFromEnv,
  type AiProviderName,
  type UndeclaredOutputFieldPolicy
} from "@magpie/jobs";
import {
  authEnvIssues,
  authSettingsFromEnv,
  isAuthRequired,
  parseAuthProvider,
  providerProfile,
  type ResolvedAuthSettings
} from "@magpie/auth";
import { resolveTelemetryConfig, type TelemetryConfig } from "@magpie/telemetry";
import { parseAiPricing, type AiPricingEntry } from "./ai-pricing.js";
import {
  getConfiguredKnowledgeDestinations,
  getConfiguredKnowledgeFlows,
  getConfiguredKnowledgeRepositories,
  getConfiguredKnowledgeSources,
  getConfiguredRoleGrants,
  type ConfiguredKnowledgeFlow,
  type ConfiguredKnowledgeRepository,
  type KnowledgeRoleGrants
} from "../stores/knowledge-repositories.js";

type StoreBackend = "memory" | "postgres";

// The per-store backend overrides. Each defaults to STORAGE_BACKEND when unset.
const STORE_ENV_NAMES = [
  "KNOWLEDGE_STORE",
  "KNOWLEDGE_CHANGE_STORE",
  "QUESTION_LOG_STORE",
  "PROPOSAL_STORE",
  "SCHEDULED_TASK_STORE",
  "SOURCE_SYNC_STORE",
  "PATROL_STORE",
  "GAP_CLUSTER_STORE",
  "RECONCILIATION_DECISION_STORE",
  "MAINTENANCE_RUN_STORE",
  "WATCHER_REGISTRY_STORE",
  "PR_CROSSLINK_STORE",
  "GAP_CLOSURE_VERIFICATION_STORE",
  "SOURCE_MAP_STORE",
  "SOURCE_CONFLICT_STORE",
  "SEED_PLAN_STORE",
  "QUESTIONNAIRE_STORE",
  "ASSERTED_CLAIMS_STORE",
  "QUESTIONNAIRE_IMPORT_STORE"
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
  // Resolved by @magpie/auth (provider, issuer, audience, JWKS/token URLs, roles
  // claim) from the generic AUTH_* names or their legacy AUTH0_* fallbacks.
  auth: ResolvedAuthSettings;
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
  // Operator-supplied token pricing (AI_PRICING, JSON array), one entry per
  // (provider, model) pair the watchers report on completions. Used to compute
  // monetary cost from stored token usage at read time; empty when unset,
  // which leaves cost reporting off. See platform/ai-pricing.ts.
  aiPricing: AiPricingEntry[];
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
      // Opt-in output width, forwarded as the `dimensions` request parameter
      // only when set — many OpenAI-compatible servers reject the field.
      embeddingDimensions?: number;
    };
    azureOpenAi: {
      endpoint?: string;
      apiKey?: string;
      chatDeployment?: string;
      embeddingDeployment?: string;
      // Opt-in output width. Needed to use text-embedding-3-large on Azure at
      // all: it returns 3072 dimensions by default, wider than the store holds.
      embeddingDimensions?: number;
      apiVersion: string;
    };
    timeoutMs?: number;
  };
  knowledge: {
    sources: ConfiguredKnowledgeRepository[];
    destinations: ConfiguredKnowledgeRepository[];
    repositories: ConfiguredKnowledgeRepository[];
    flows: ConfiguredKnowledgeFlow[];
    // role name -> flow id (or "*") -> capabilities. Empty when unset, which leaves
    // flow-scoped authorization inactive (see getConfiguredRoleGrants).
    roleGrants: KnowledgeRoleGrants;
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
    scheduleTimezone: string;
    // Whether a schema-invalid completion of a repairable provider job gets one
    // informed repair-reprompt before terminal-failing (#288d). On by default;
    // MAGPIE_JOB_REPAIR_ENABLED=false makes every schema-invalid output take the
    // immediate terminal-fail backstop instead. Mirrors rateLimit.enabled.
    repairEnabled: boolean;
    // What a completion carrying a field its job contract does not declare does.
    // "strip" (the default) keeps production lenient: the field is dropped and
    // logged. "reject" — MAGPIE_JOB_OUTPUT_STRICT=true, set by the test context
    // and the e2e/eval harnesses — terminal-fails the job instead, so a watcher
    // or prompt emitting an undeclared field fails before it ships (J24).
    undeclaredOutputFields: UndeclaredOutputFieldPolicy;
  };
  // Per-principal request throttling and a global cap on concurrent metered AI
  // work. Enforced by the API's rate-limit middleware (L1) and enqueue-time
  // capacity guard (L2). Every decision is logged as a structured event
  // (event=rate_limit / event=ai_capacity) for dashboards; see docs/rate-limiting.md.
  rateLimit: {
    // Master switch. When false, both L1 and L2 are pass-throughs. Independent of
    // auth, but L1 can only key on a principal, so it also no-ops when a request
    // has none (auth disabled) even while enabled.
    enabled: boolean;
    // Fixed-window width shared by both request tiers.
    windowMs: number;
    // Max requests per principal per window for the ask tier (/ask, /retrieve).
    askPerWindow: number;
    // Max requests per principal per window for the expensive manual-trigger tier
    // (source-sync/patrol/scheduled-task run, repository index).
    triggerPerWindow: number;
    // When a request has no principal, the limiter falls back to a per-client-IP
    // key. Set true only when the API sits behind a trusted reverse proxy so the
    // left-most `X-Forwarded-For` entry is the real client; otherwise the raw
    // socket peer (the proxy) is used, since the header is client-spoofable.
    trustForwardedFor: boolean;
    // Global ceiling on in-flight (created|retry|active) AI jobs. New AI work is
    // rejected at enqueue with 429 once this many are already in flight.
    aiMaxInflightJobs: number;
    // In-flight slots reserved for interactive AI jobs (a live caller waiting —
    // INTERACTIVE_AI_JOB_TYPES): an interactive enqueue is rejected only once
    // this many interactive jobs are in flight AND the global ceiling is
    // reached, so maintenance fan-out can never push /api/ask into 429 (#240).
    // 0 disables the reserve (pre-#240 behaviour); values above the ceiling are
    // clamped to it at the gate.
    aiInteractiveReservedJobs: number;
    // The most AI jobs a single maintenance fan-out tick (a patrol/reconciler
    // run) may enqueue (#288b). A per-tick budget layered UNDER the global
    // admission ceiling: even with capacity free, one tick can enqueue at most
    // this many before deferring the rest to a later tick. Kept <= the maintenance
    // ceiling (limit - reserved) so one tick can never fill it. Only meaningful
    // while RATE_LIMIT_ENABLED (the master switch), like the rest of this object.
    maintenanceMaxAiJobsPerTick: number;
    // When a single fan-out tick defers/rejects at least this many enqueues, the
    // `maintenance_fanout` event is flagged `runaway` and escalated — the proactive
    // signal that a patrol is fanning out far past its budget (#288b).
    maintenanceFanoutAlertDeferred: number;
  };
  // Sparse-flow seed bootstrap (SEED_BOOTSTRAP_MAX_DOCS): a flow whose indexed
  // destination has fewer than this many documents counts as "near-empty" and is
  // eligible for an auto-proposed seed plan.
  seeding: {
    bootstrapMaxDocs: number;
  };
  // Abstain-biased cosine cut-offs for the embedding-based flow router (POST
  // /api/route). A mis-tune only makes the router abstain more often — the watcher
  // then does the chat routing call it would have done anyway — so these degrade
  // safely and never affect routing correctness. See docs/question-logging.md.
  flowRouter: FlowRouterConfig;
  // Phase-1 gap assignment: the cosine floor a new gap must clear against an
  // active cluster's representative embedding to join it (and for two new gaps
  // to seed one shared cluster). Deliberately conservative — it collapses only
  // obvious near-duplicates; subtler consolidation is the reshape critic's job.
  // A blank or out-of-range value falls back to the default rather than failing
  // boot: like the flow-router cut-offs this is a safety-neutral tuning knob
  // (a mis-tune only changes how much pre-collapsing phase 1 does).
  gapClustering: GapClusteringConfig;
  // Questionnaire mode (docs/questionnaires.md): near-verbatim match threshold
  // and the per-questionnaire answer-drip concurrency cap. Safety-neutral
  // tuning knobs — a mis-tune only changes reuse frequency / drip pace, never
  // answer correctness — so out-of-range values fall back rather than fail boot.
  questionnaires: QuestionnaireConfig;
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
  // OpenTelemetry export. Off unless an OTLP endpoint is configured; the SDK reads
  // the rest of its OTEL_* env itself, so only the resolved on/off + service name
  // live here (resolved like `knowledge` below, via a helper rather than the zod
  // schema, because OTel's env surface is large and standardised).
  telemetry: TelemetryConfig;
}

// Abstain-biased cosine cut-offs for the embedding flow router. Conservative
// starting points: the top flow must clear `minTopScore` and beat the runner-up by
// `minMargin`, else the router abstains and the watcher falls back to the chat call.
interface FlowRouterConfig {
  minTopScore: number;
  minMargin: number;
}

const FLOW_ROUTER_DEFAULT_MIN_SCORE = 0.25;
const FLOW_ROUTER_DEFAULT_MIN_MARGIN = 0.05;

// Resolved via a helper (like telemetry) rather than the main schema. A blank or
// out-of-range value falls back to the default rather than failing boot: these are
// safety-neutral tuning knobs, and a bad one must never take the ask path down —
// the router just abstains to the chat fallback. A value must be a finite number in
// [0,1] (cosine range for non-negative similarity) to be honoured.
function resolveFlowRouterConfig(env: NodeJS.ProcessEnv): FlowRouterConfig {
  return {
    minTopScore: parseUnitFloat(env.FLOW_ROUTER_MIN_SCORE, FLOW_ROUTER_DEFAULT_MIN_SCORE),
    minMargin: parseUnitFloat(env.FLOW_ROUTER_MIN_MARGIN, FLOW_ROUTER_DEFAULT_MIN_MARGIN)
  };
}

interface GapClusteringConfig {
  assignThreshold: number;
}

// Chosen by the offline sweep in scripts/eval-gap-threshold.ts (fixture:
// text-embedding-3-small): zero over-merges from 0.82 across the labelled
// paraphrase/trap corpus — the worst must-not-merge pair (encryption in transit
// vs at rest) sits at 0.810 — so the default is that floor plus a 0.02 safety
// margin. At 0.84 every near-identical rewording still collapses (pair
// precision 1.0). Re-run the sweep before changing this, and re-tune via
// GAP_CLUSTER_ASSIGN_THRESHOLD if a deployment uses a different embedding model.
const GAP_CLUSTER_DEFAULT_ASSIGN_THRESHOLD = 0.84;

function resolveGapClusteringConfig(env: NodeJS.ProcessEnv): GapClusteringConfig {
  const value = parseUnitFloat(env.GAP_CLUSTER_ASSIGN_THRESHOLD, GAP_CLUSTER_DEFAULT_ASSIGN_THRESHOLD);
  // A threshold of 0 would bucket every gap together; treat it as invalid.
  return { assignThreshold: value > 0 ? value : GAP_CLUSTER_DEFAULT_ASSIGN_THRESHOLD };
}

interface QuestionnaireConfig {
  // Cosine floor for "the same question re-asked": deliberately the same
  // conservative bar the gap-cluster assignment landed on (near-identical
  // rewordings only with text-embedding-3-small — see the 0.84 rationale above).
  matchThreshold: number;
  // Items a single questionnaire keeps in the answer pipeline at once. Kept
  // small so a 200-question batch can never monopolise the interactive
  // in-flight reservation that protects live /api/ask traffic (#240).
  maxInflight: number;
  // top-N approved answers fed to the reconcile step, default 3
  reconcileCandidates: number;
  // off falls back to the deterministic-veto path, default true
  reconcileEnabled: boolean;
}

const QUESTIONNAIRE_DEFAULT_MATCH_THRESHOLD = 0.84;
const QUESTIONNAIRE_DEFAULT_MAX_INFLIGHT = 3;
const QUESTIONNAIRE_DEFAULT_RECONCILE_CANDIDATES = 3;

function resolveQuestionnaireConfig(env: NodeJS.ProcessEnv): QuestionnaireConfig {
  const threshold = parseUnitFloat(env.QUESTIONNAIRE_MATCH_THRESHOLD, QUESTIONNAIRE_DEFAULT_MATCH_THRESHOLD);
  const rawInflight = Number.parseInt(env.QUESTIONNAIRE_MAX_INFLIGHT ?? "", 10);
  const rawCandidates = Number.parseInt(env.QUESTIONNAIRE_RECONCILE_CANDIDATES ?? "", 10);
  return {
    // A threshold of 0 would match every prior item; treat it as invalid.
    matchThreshold: threshold > 0 ? threshold : QUESTIONNAIRE_DEFAULT_MATCH_THRESHOLD,
    maxInflight: Number.isInteger(rawInflight) && rawInflight > 0 ? rawInflight : QUESTIONNAIRE_DEFAULT_MAX_INFLIGHT,
    reconcileCandidates:
      Number.isInteger(rawCandidates) && rawCandidates > 0 ? rawCandidates : QUESTIONNAIRE_DEFAULT_RECONCILE_CANDIDATES,
    reconcileEnabled: env.QUESTIONNAIRE_RECONCILE_ENABLED !== "0"
  };
}

function parseUnitFloat(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
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

// Like optionalPositiveInt but 0 is meaningful (e.g. "reserve no slots").
const optionalNonNegativeInt = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .regex(/^\d+$/, "must be a non-negative integer")
    .transform((value) => Number.parseInt(value, 10))
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
    OPENAI_COMPATIBLE_EMBEDDING_DIMENSIONS: optionalPositiveInt,
    AZURE_OPENAI_ENDPOINT: optionalUrl,
    AZURE_OPENAI_API_KEY: optionalString,
    AZURE_OPENAI_CHAT_DEPLOYMENT: optionalString,
    AZURE_OPENAI_EMBEDDING_DEPLOYMENT: optionalString,
    AZURE_OPENAI_EMBEDDING_DIMENSIONS: optionalPositiveInt,
    AZURE_OPENAI_API_VERSION: optionalString,
    EMBEDDING_TIMEOUT_MS: optionalPositiveInt,

    MAGPIE_CHECKOUT_ROOT: optionalString,
    MAGPIE_SNAPSHOT_ROOT: optionalString,
    MAGPIE_LOCAL_INDEX_ROOT: optionalString,
    KNOWLEDGE_REPO_PATH: optionalString,

    JOB_WAIT_TIMEOUT_MS: optionalPositiveInt,
    JOB_WAIT_POLL_MS: optionalPositiveInt,
    JOB_SCHEDULE_TIMEZONE: optionalString,
    MAGPIE_JOB_REPAIR_ENABLED: optionalString,
    MAGPIE_JOB_OUTPUT_STRICT: optionalString,

    RATE_LIMIT_ENABLED: optionalString,
    RATE_LIMIT_WINDOW_MS: optionalPositiveInt,
    RATE_LIMIT_ASK_PER_WINDOW: optionalPositiveInt,
    RATE_LIMIT_TRIGGER_PER_WINDOW: optionalPositiveInt,
    RATE_LIMIT_TRUST_FORWARDED_FOR: optionalString,
    AI_MAX_INFLIGHT_JOBS: optionalPositiveInt,
    AI_INTERACTIVE_RESERVED_JOBS: optionalNonNegativeInt,
    MAINTENANCE_MAX_AI_JOBS_PER_TICK: optionalPositiveInt,
    MAINTENANCE_FANOUT_ALERT_DEFERRED: optionalPositiveInt,
    SEED_BOOTSTRAP_MAX_DOCS: optionalPositiveInt,

    WATCHER_NAME: optionalString,
    WATCHER_POLL_INTERVAL_MS: optionalPositiveInt,
    WATCHER_ACTIVE_WINDOW_MS: optionalPositiveInt,
    AGENT_API_TIMEOUT_MS: optionalPositiveInt,

    GIT_PROVIDER: optionalString,
    GITHUB_TOKEN: optionalString,
    AZURE_DEVOPS_PAT: optionalString,

    AUTH_REQUIRED: optionalString,
    AUTH_PROVIDER: optionalString,
    AUTH_ISSUER: optionalString,
    AUTH_AUDIENCE: optionalString,
    // Legacy Auth0 names, still honoured as fallbacks for the generic ones above.
    AUTH0_DOMAIN: optionalString,
    AUTH0_ISSUER_BASE_URL: optionalString,
    AUTH0_AUDIENCE: optionalString,

    AI_PRICING: optionalString
  })
  .extend(storeOverridesSchema.shape)
  .superRefine((env, ctx) => {
    // Pricing fails LOUD, not silent: unlike the safety-neutral tuning knobs a
    // malformed price table would quietly produce wrong monetary numbers, so
    // every problem fails boot with the same aggregated config error.
    for (const message of parseAiPricing(env.AI_PRICING).errors) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["AI_PRICING"], message });
    }
  })
  .superRefine((env, ctx) => {
    // Auth wiring lives in @magpie/auth; we only assert coherence here so a
    // misconfigured deployment fails at boot instead of on the first request.
    // AUTH_PROVIDER is always validated; the audience/issuer (generic AUTH_* names
    // or their legacy AUTH0_* fallbacks) only when auth is enabled.
    //
    // Auth fails CLOSED: it is required unless an operator EXPLICITLY opts out
    // with AUTH_REQUIRED=false. An unset/blank/typo'd value leaves auth on, so a
    // misconfiguration can never silently expose the whole API. The placeholder
    // audience from .env.example is rejected too: booting with it would accept
    // tokens for a non-existent audience.
    const issues = authEnvIssues(env, {
      requireEndpoints: isAuthRequired(env.AUTH_REQUIRED),
      context: "when auth is enabled (set AUTH_REQUIRED=false to disable auth)"
    });
    for (const issue of issues) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [issue.variable], message: issue.message });
    }
  });

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

interface ConfigIssue {
  variable: string;
  message: string;
}

// Authorization config that must cohere at boot. On a provider whose user-token
// scopes are NOT per-user (Entra: every consented delegated scope reaches every
// user who can sign in), privileged actions are authorized from app roles via
// KNOWLEDGE_ROLE_GRANTS (docs/authorization.md AZ27). Booting such a deployment
// with auth on and no grants would leave no human able to administer it — and,
// before AZ27, left every signed-in user effectively an admin — so it fails loud.
function authorizationConfigIssues(env: NodeJS.ProcessEnv): ConfigIssue[] {
  const provider = parseAuthProvider(env.AUTH_PROVIDER);
  // An unrecognised provider is already reported by the schema's auth check.
  if (provider === undefined || !isAuthRequired(env.AUTH_REQUIRED) || providerProfile(provider).perUserScopes) {
    return [];
  }
  if (Object.keys(getConfiguredRoleGrants(env)).length > 0) {
    return [];
  }
  return [
    {
      variable: "KNOWLEDGE_ROLE_GRANTS",
      message:
        `is required when AUTH_PROVIDER=${provider} and auth is enabled: ${provider} grants every delegated scope to ` +
        "every user who can sign in, so admin and job/schedule management are authorized from app roles mapped in " +
        'KNOWLEDGE_ROLE_GRANTS (e.g. {"magpie-admins":{"*":["read","manage","ask","admin","ops"]}}). ' +
        "See docs/authorization.md AZ27."
    }
  ];
}

// Reads and validates the API's environment once at startup, returning a typed
// config object. Throws a single aggregated Error naming every offending var on
// invalid/missing-required config. `env` is injectable so tests need not mutate
// process.env.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = schema.safeParse(env);
  const lines = result.success
    ? []
    : result.error.issues.map((issue) => {
        const name = issue.path.join(".") || "(root)";
        return `  - ${name}: ${issue.message}`;
      });
  for (const issue of authorizationConfigIssues(env)) {
    lines.push(`  - ${issue.variable}: ${issue.message}`);
  }
  if (!result.success || lines.length > 0) {
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
    // The superRefine above already failed boot on any parse error, so only
    // valid entries can reach here.
    aiPricing: parseAiPricing(parsed.AI_PRICING).entries,
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
        embeddingModel: parsed.OPENAI_COMPATIBLE_EMBEDDING_MODEL,
        embeddingDimensions: parsed.OPENAI_COMPATIBLE_EMBEDDING_DIMENSIONS
      },
      azureOpenAi: {
        endpoint: parsed.AZURE_OPENAI_ENDPOINT,
        apiKey: parsed.AZURE_OPENAI_API_KEY,
        chatDeployment: parsed.AZURE_OPENAI_CHAT_DEPLOYMENT,
        embeddingDeployment: parsed.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
        embeddingDimensions: parsed.AZURE_OPENAI_EMBEDDING_DIMENSIONS,
        apiVersion: parsed.AZURE_OPENAI_API_VERSION ?? "2024-10-21"
      },
      timeoutMs: parsed.EMBEDDING_TIMEOUT_MS
    },
    knowledge: {
      sources,
      destinations,
      repositories: getConfiguredKnowledgeRepositories(env),
      flows: getConfiguredKnowledgeFlows(env, sources, destinations),
      roleGrants: getConfiguredRoleGrants(env),
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
      scheduleTimezone: parsed.JOB_SCHEDULE_TIMEZONE ?? "UTC",
      // On unless explicitly disabled, matching rateLimit.enabled's fail-safe default.
      repairEnabled: parsed.MAGPIE_JOB_REPAIR_ENABLED !== "false",
      // Lenient unless explicitly switched on — see undeclaredOutputFieldPolicyFromEnv.
      undeclaredOutputFields: undeclaredOutputFieldPolicyFromEnv(parsed)
    },
    rateLimit: {
      // On unless explicitly disabled (RATE_LIMIT_ENABLED=false), matching the
      // fail-safe default used elsewhere in this config.
      enabled: parsed.RATE_LIMIT_ENABLED !== "false",
      windowMs: parsed.RATE_LIMIT_WINDOW_MS ?? 60_000,
      askPerWindow: parsed.RATE_LIMIT_ASK_PER_WINDOW ?? 30,
      triggerPerWindow: parsed.RATE_LIMIT_TRIGGER_PER_WINDOW ?? 5,
      // Off by default: without a trusted proxy the socket peer is the honest key.
      trustForwardedFor: parsed.RATE_LIMIT_TRUST_FORWARDED_FOR === "true",
      aiMaxInflightJobs: parsed.AI_MAX_INFLIGHT_JOBS ?? 20,
      aiInteractiveReservedJobs: parsed.AI_INTERACTIVE_RESERVED_JOBS ?? 5,
      // Default 12 <= limit - reserved (20 - 5 = 15), so one tick can never fill
      // the maintenance ceiling on its own.
      maintenanceMaxAiJobsPerTick: parsed.MAINTENANCE_MAX_AI_JOBS_PER_TICK ?? 12,
      maintenanceFanoutAlertDeferred: parsed.MAINTENANCE_FANOUT_ALERT_DEFERRED ?? 20
    },
    seeding: {
      bootstrapMaxDocs: parsed.SEED_BOOTSTRAP_MAX_DOCS ?? 3
    },
    flowRouter: resolveFlowRouterConfig(env),
    gapClustering: resolveGapClusteringConfig(env),
    questionnaires: resolveQuestionnaireConfig(env),
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
    },
    telemetry: resolveTelemetryConfig(env, "api")
  };
}
