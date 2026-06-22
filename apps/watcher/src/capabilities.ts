import type { JobCapability } from "@magpie/jobs";

// A single readiness gate per capability, expressed against the watcher's
// environment. The runner factory (runners/index.ts) consults the same gates so
// a capability is advertised on claim if and only if a runner can actually
// execute it — there is deliberately no `mock` capability.
//
// Secrets are only tested for presence here; they are never logged or returned.
export interface CapabilityGate {
  capability: JobCapability;
  // Human-readable names of the env vars this capability requires, so main.ts
  // can log readiness as set/MISSING without hard-coding the list twice.
  requiredEnv: readonly string[];
  ready(env: NodeJS.ProcessEnv): boolean;
}

function allSet(env: NodeJS.ProcessEnv, names: readonly string[]): boolean {
  return names.every((name) => Boolean(env[name]?.trim()));
}

// Order matters only for stable, predictable logging/claim output.
export const CAPABILITY_GATES: readonly CapabilityGate[] = [
  {
    capability: "openai-compatible",
    requiredEnv: ["OPENAI_COMPATIBLE_BASE_URL", "OPENAI_COMPATIBLE_API_KEY", "OPENAI_COMPATIBLE_MODEL"],
    ready: (env) => allSet(env, ["OPENAI_COMPATIBLE_BASE_URL", "OPENAI_COMPATIBLE_API_KEY", "OPENAI_COMPATIBLE_MODEL"])
  },
  {
    capability: "azure-openai",
    requiredEnv: ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_CHAT_DEPLOYMENT"],
    ready: (env) => allSet(env, ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_CHAT_DEPLOYMENT"])
  },
  {
    capability: "codex",
    requiredEnv: ["CODEX_CLI_PATH"],
    ready: (env) => allSet(env, ["CODEX_CLI_PATH"])
  },
  {
    capability: "claude",
    requiredEnv: ["CLAUDE_CLI_PATH"],
    ready: (env) => allSet(env, ["CLAUDE_CLI_PATH"])
  },
  {
    capability: "github",
    requiredEnv: ["GITHUB_TOKEN", "MAGPIE_GIT_AUTHOR_NAME", "MAGPIE_GIT_AUTHOR_EMAIL"],
    ready: (env) => allSet(env, ["GITHUB_TOKEN", "MAGPIE_GIT_AUTHOR_NAME", "MAGPIE_GIT_AUTHOR_EMAIL"])
  },
  {
    // Maintenance jobs need nothing beyond an API connection, so the watcher can
    // always pick them up.
    capability: "maintenance",
    requiredEnv: [],
    ready: () => true
  }
];

// The capabilities this watcher will advertise on claim, given its environment.
export function deriveCapabilities(env: NodeJS.ProcessEnv): JobCapability[] {
  return CAPABILITY_GATES.filter((gate) => gate.ready(env)).map((gate) => gate.capability);
}
