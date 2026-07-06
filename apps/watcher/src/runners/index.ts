import { createAzure } from "@ai-sdk/azure";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createChatProvider } from "@magpie/retrieval";
import { CAPABILITY_GATES, DEFAULT_CAPABILITY_RUNTIME, type CapabilityRuntime } from "../capabilities.js";
import type { WatcherApi } from "../http-client.js";
import { ChatRunner } from "./chat.js";
import { CliRunner, type PromptMode } from "./cli.js";
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
          timeoutMs
        }),
        api,
        openaiAgentModel
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
    const azureAgentModel = createAzure({
      apiKey: env.AZURE_OPENAI_API_KEY ?? "",
      baseURL: `${trimTrailingSlash(env.AZURE_OPENAI_ENDPOINT ?? "")}/openai`,
      ...(env.AZURE_OPENAI_API_VERSION ? { apiVersion: env.AZURE_OPENAI_API_VERSION } : {})
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
          timeoutMs
        }),
        api,
        azureAgentModel
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

function normalizePromptMode(value: string | undefined): PromptMode {
  return value === "stdin" ? "stdin" : "arg";
}

// Only pass `model` when a non-blank value is configured, so an unset/blank env
// var leaves the CLI on its own default model rather than passing `--model ""`.
function optionalModel(value: string | undefined): { model: string } | Record<string, never> {
  const trimmed = value?.trim();
  return trimmed ? { model: trimmed } : {};
}

// The same trailing-slash normalisation the chat/embedding providers apply to
// their endpoints, so a `.../` env value cannot produce `//chat/completions` URLs.
function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
