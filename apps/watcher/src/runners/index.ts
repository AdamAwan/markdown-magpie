import { createAzure } from "@ai-sdk/azure";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { undeclaredOutputFieldPolicyFromEnv } from "@magpie/jobs";
import { createChatProvider, DEFAULT_CHAT_RETRY_POLICY, type ChatProviderConfig } from "@magpie/retrieval";
import { CAPABILITY_GATES, DEFAULT_CAPABILITY_RUNTIME, type CapabilityRuntime } from "../capabilities.js";
import type { WatcherApi } from "../http-client.js";
import { logger } from "../logger.js";
import { ChatRunner } from "./chat.js";
import { CliRunner, DEFAULT_CLI_MAX_OUTPUT_BYTES, type PromptMode } from "./cli.js";
import { MaintenanceRunner } from "./maintenance.js";
import { createGitPublicationDeps, PublicationRunner } from "./publication.js";
import { RefreshFlowSnapshotRunner } from "./refresh-flow-snapshot.js";
import type { JobRunner } from "./types.js";

export type { JobRunner } from "./types.js";

const DEFAULT_CHAT_TIMEOUT_MS = 120_000;

// Builds exactly the runners this watcher's environment can support, using the
// same readiness gates the capability advertisement uses (so an advertised
// capability always has a runner, and vice versa). No mock runner exists.
export function createConfiguredRunners(
  env: NodeJS.ProcessEnv,
  api: WatcherApi,
  runtime: CapabilityRuntime = DEFAULT_CAPABILITY_RUNTIME
): JobRunner[] {
  const runners: JobRunner[] = [];
  const ready = (capability: string): boolean =>
    CAPABILITY_GATES.find((gate) => gate.capability === capability)?.ready(env, runtime) ?? false;

  const timeoutMs = positiveInt(env.AGENT_API_TIMEOUT_MS, DEFAULT_CHAT_TIMEOUT_MS);
  // Source-grounded CLI runs explore a checkout, so they get their own, much
  // longer budget than the one-shot AGENT_CLI_TIMEOUT_MS.
  const agenticTimeoutMs = positiveInt(env.MAGPIE_AGENTIC_TIMEOUT_MS, 600_000);
  // Shared by both hosted chat providers — see chatTemperature below.
  const temperature = chatTemperature(env.CHAT_TEMPERATURE);
  // Bounded in-process retry of a transient provider failure (429/408/5xx,
  // timeout, dropped connection), honouring Retry-After (J81). Shared by both
  // hosted chat providers; AGENT_API_MAX_RETRIES=0 disables it.
  const chatRetry = chatRetryConfig(env);
  // Production is lenient about an undeclared field in a model's output (strip +
  // warn); MAGPIE_JOB_OUTPUT_STRICT=true — set by the e2e/eval harnesses — makes
  // it a hard failure. Named explicitly on every AI runner because the runners
  // themselves default to strict (so tests are strict without opting in).
  const undeclaredOutputFields = undeclaredOutputFieldPolicyFromEnv(env);

  if (ready("openai-compatible")) {
    // The agent model drives the source-agent tool loop for source-grounded jobs;
    // the readiness gate guarantees the env vars are set (the `?? ""` fallbacks
    // are unreachable but keep the types honest — no non-null assertions).
    const openaiAgentModel = createOpenAICompatible({
      name: "openai-compatible",
      baseURL: trimTrailingSlash(env.OPENAI_COMPATIBLE_BASE_URL ?? ""),
      ...(env.OPENAI_COMPATIBLE_API_KEY ? { apiKey: env.OPENAI_COMPATIBLE_API_KEY } : {})
    }).chatModel(env.OPENAI_COMPATIBLE_MODEL ?? "");
    runners.push(
      new ChatRunner(
        "openai-compatible",
        createChatProvider({
          provider: "openai-compatible",
          apiKey: env.OPENAI_COMPATIBLE_API_KEY,
          baseUrl: env.OPENAI_COMPATIBLE_BASE_URL,
          model: env.OPENAI_COMPATIBLE_MODEL,
          timeoutMs,
          ...temperature,
          ...chatRetry
        }),
        api,
        {
          agentModel: openaiAgentModel,
          agenticTimeoutMs,
          undeclaredOutputFields,
          ...optionalModel(env.OPENAI_COMPATIBLE_MODEL)
        }
      )
    );
  }

  if (ready("azure-openai")) {
    // AZURE_OPENAI_ENDPOINT is the bare resource endpoint
    // (https://<res>.openai.azure.com) but the SDK builds request URLs directly
    // from baseURL, so the `/openai` segment must be appended here. `.chat()`
    // selects the classic chat-completions API (the callable form is the
    // responses API), and the apiKey is passed explicitly because the SDK's env
    // fallback reads AZURE_API_KEY, not this repo's AZURE_OPENAI_API_KEY.
    // useDeploymentBasedUrls pins the SDK to the classic deployments surface —
    // {endpoint}/openai/deployments/{deployment}/chat/completions?api-version={v}
    // — the exact URL AzureOpenAIChatProvider builds. AZURE_OPENAI_API_VERSION
    // carries dated tokens ("2024-10-21") for that surface; the SDK's default v1
    // surface expects "v1"/"preview"-style tokens and would 400 on them. The
    // fallback mirrors createChatProvider's default
    // (packages/retrieval/src/chat-providers.ts) so both Azure paths stay in step.
    const azureAgentModel = createAzure({
      apiKey: env.AZURE_OPENAI_API_KEY ?? "",
      baseURL: `${trimTrailingSlash(env.AZURE_OPENAI_ENDPOINT ?? "")}/openai`,
      useDeploymentBasedUrls: true,
      apiVersion: env.AZURE_OPENAI_API_VERSION ?? "2024-10-21"
    }).chat(env.AZURE_OPENAI_CHAT_DEPLOYMENT ?? "");
    runners.push(
      new ChatRunner(
        "azure-openai",
        createChatProvider({
          provider: "azure-openai",
          apiKey: env.AZURE_OPENAI_API_KEY,
          azureEndpoint: env.AZURE_OPENAI_ENDPOINT,
          azureDeployment: env.AZURE_OPENAI_CHAT_DEPLOYMENT,
          ...(env.AZURE_OPENAI_API_VERSION ? { azureApiVersion: env.AZURE_OPENAI_API_VERSION } : {}),
          timeoutMs,
          ...temperature,
          ...chatRetry
        }),
        api,
        // Azure's "model" for pricing purposes is the deployment name — the
        // operator prices whatever the deployment serves.
        {
          agentModel: azureAgentModel,
          agenticTimeoutMs,
          undeclaredOutputFields,
          ...optionalModel(env.AZURE_OPENAI_CHAT_DEPLOYMENT)
        }
      )
    );
  }

  if (ready("codex")) {
    runners.push(
      new CliRunner({
        capability: "codex",
        command: env.CODEX_CLI_PATH ?? "codex",
        args: splitArgs(env.CODEX_CLI_ARGS ?? "exec"),
        promptMode: normalizePromptMode(env.CODEX_CLI_PROMPT_MODE),
        ...optionalModel(env.CODEX_CLI_MODEL),
        api,
        timeoutMs: positiveInt(env.AGENT_CLI_TIMEOUT_MS, DEFAULT_CHAT_TIMEOUT_MS),
        agenticTimeoutMs,
        undeclaredOutputFields,
        maxOutputBytes: positiveInt(env.AGENT_CLI_MAX_OUTPUT_BYTES, DEFAULT_CLI_MAX_OUTPUT_BYTES),
        ...(env.CLI_CANCEL_GRACE_MS ? { cancelGraceMs: positiveInt(env.CLI_CANCEL_GRACE_MS, 5_000) } : {})
      })
    );
  }

  if (ready("claude")) {
    runners.push(
      new CliRunner({
        capability: "claude",
        command: env.CLAUDE_CLI_PATH ?? "claude",
        args: splitArgs(env.CLAUDE_CLI_ARGS ?? "-p"),
        promptMode: normalizePromptMode(env.CLAUDE_CLI_PROMPT_MODE),
        ...optionalModel(env.CLAUDE_CLI_MODEL),
        api,
        timeoutMs: positiveInt(env.AGENT_CLI_TIMEOUT_MS, DEFAULT_CHAT_TIMEOUT_MS),
        agenticTimeoutMs,
        undeclaredOutputFields,
        maxOutputBytes: positiveInt(env.AGENT_CLI_MAX_OUTPUT_BYTES, DEFAULT_CLI_MAX_OUTPUT_BYTES),
        ...(env.CLI_CANCEL_GRACE_MS ? { cancelGraceMs: positiveInt(env.CLI_CANCEL_GRACE_MS, 5_000) } : {})
      })
    );
  }

  // The publication runner serves both github and local-git publish work. A
  // local-git-only watcher advertises neither github nor its crosslink/comment
  // queues, so it only ever claims publish_proposal__local_git — the runner's
  // github-only job types stay dormant. Registered once when either is ready.
  if (ready("github") || ready("local-git")) {
    runners.push(new PublicationRunner(api, createGitPublicationDeps()));
  }

  if (ready("github")) {
    // refresh_flow_snapshot is a github-capability job: it polls open PRs with the
    // watcher's GitHub credentials and reports state back for the API to apply.
    runners.push(new RefreshFlowSnapshotRunner(api));
  }

  if (ready("maintenance")) {
    // Maintenance jobs do no generative or git work themselves; they POST thin API
    // endpoints that own the orchestration (gap reconcile, source-sync, fix/improve
    // patrol).
    runners.push(new MaintenanceRunner(api));
  }

  return runners;
}

function splitArgs(value: string): string[] {
  return value
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean);
}

// stdin unless the operator explicitly asks for `arg` (J80): an argv prompt
// fails to spawn above the OS argument limit, which real prompts exceed.
export function normalizePromptMode(value: string | undefined): PromptMode {
  return value?.trim().toLowerCase() === "arg" ? "arg" : "stdin";
}

// Only pass `model` when a non-blank value is configured: for CLI runners an
// unset/blank env var leaves the CLI on its own default model rather than
// passing `--model ""`, and for every runner it keeps a blank value out of the
// aiIdentity reported on completions.
function optionalModel(value: string | undefined): { model: string } | Record<string, never> {
  const trimmed = value?.trim();
  return trimmed ? { model: trimmed } : {};
}

// The same trailing-slash normalisation the chat/embedding providers apply to
// their endpoints, so a `.../` env value cannot produce `//chat/completions` URLs.
function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

// CHAT_TEMPERATURE for both hosted chat providers (#364). `default`
// (case-insensitive) means "send no temperature at all", which is what
// reasoning deployments (GPT-5-class, o-series) require — they reject any
// explicit value with HTTP 400. A finite number overrides the provider default.
// Unset or unparseable leaves the field absent, so the provider keeps sending
// DEFAULT_CHAT_TEMPERATURE and existing deployments are unchanged.
function chatTemperature(value: string | undefined): { temperature: number | null } | Record<string, never> {
  const trimmed = value?.trim();
  if (!trimmed) {
    return {};
  }
  if (trimmed.toLowerCase() === "default") {
    return { temperature: null };
  }
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? { temperature: parsed } : {};
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// AGENT_API_MAX_RETRIES (default DEFAULT_CHAT_RETRY_POLICY.maxRetries = 2; 0
// disables) plus a warn line per retry, so a throttled provider is visible in
// the watcher log rather than only as slower jobs.
function chatRetryConfig(env: NodeJS.ProcessEnv): Pick<ChatProviderConfig, "retry" | "retryHooks"> {
  const raw = env.AGENT_API_MAX_RETRIES?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  const maxRetries =
    Number.isInteger(parsed) && parsed >= 0 && parsed <= 10 ? parsed : DEFAULT_CHAT_RETRY_POLICY.maxRetries;
  return {
    retry: { maxRetries },
    retryHooks: {
      onRetry: ({ attempt, delayMs, error }) =>
        logger.warn(
          { attempt, delayMs, status: error.status, kind: error.kind, err: error.message },
          `chat provider request failed transiently; retry ${attempt}/${maxRetries} in ${delayMs}ms`
        )
    }
  };
}
