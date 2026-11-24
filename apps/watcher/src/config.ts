import { z } from "zod";
import { authEnvIssues, authSettingsFromEnv, isAuthRequired, type AuthProvider } from "@magpie/auth";
import { resolveTelemetryConfig, type TelemetryConfig } from "@magpie/telemetry";

// The validated, env-derived static configuration for the watcher. Read and
// checked once at startup (see loadWatcherConfig); the composition root consumes
// this instead of touching process.env, so a misconfigured watcher fails fast at
// boot with an aggregated error rather than silently falling back to localhost
// defaults and 401ing every claim in production.
//
// This mirrors the API's platform/config.ts. Health-server config is validated
// separately (see loadHealthConfig); capability gating stays in capabilities.ts
// (it correctly derives from credential presence). This module owns the rest of
// the watcher's core wiring: where the API is, how often to poll, and the
// machine-to-machine credential used to authenticate to the API.
export interface WatcherConfig {
  // The Markdown Magpie API base URL the watcher claims jobs from and posts
  // results back to. Defaults to localhost only when auth is disabled (dev);
  // required in production so a missing value fails fast instead of silently
  // pointing a production watcher at localhost.
  apiBaseUrl: string;
  // The operator-set label for this watcher (before the per-process uuid is
  // appended in the composition root). Safe dev default.
  watcherName: string;
  pollIntervalMs: number;
  // Abort deadline (ms) for the maintenance orchestration callbacks
  // (reconcile-gaps, source-sync, fix-patrol, improve-patrol). Those API
  // endpoints bounded-wait on a batch of AI jobs and legitimately run for
  // minutes, so they need a far longer deadline than the hot-path request
  // timeout. Defaults to 15 minutes; raise it toward the maintenance job's
  // 1-hour budget for very large patrol batches.
  maintenanceTimeoutMs: number;
  auth: {
    required: boolean;
    // Legacy static token; used as a fallback when the client-credentials quad
    // is absent (preserves prior behaviour).
    staticToken?: string;
    // Preferred machine-to-machine client-credentials grant. Both halves are
    // required together.
    clientId?: string;
    clientSecret?: string;
    // Derived from the same auth settings (provider, issuer, audience) the API
    // validates against — see authSettingsFromEnv in @magpie/auth.
    provider: AuthProvider;
    tokenUrl: string;
    audience: string;
    // Entra only: the API's Application ID URI (client-credentials scope base).
    apiIdUri?: string;
  };
  // OpenTelemetry export. Off unless an OTLP endpoint is configured; resolved via
  // a helper (not the zod schema) because the SDK reads the rest of its own OTEL_* env.
  telemetry: TelemetryConfig;
}

// An unset var and an explicitly-empty one (a blank `FOO=` line, common in .env
// files) both mean "use the default", so collapse "" to undefined before any
// validation runs.
const emptyToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url("must be a valid URL").optional());
const optionalPositiveInt = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .regex(/^\d+$/, "must be a positive integer")
    .transform((value) => Number.parseInt(value, 10))
    .refine((value) => value > 0, "must be greater than 0")
    .optional()
);

const schema = z
  .object({
    API_BASE_URL: optionalUrl,
    WATCHER_NAME: optionalString,
    WATCHER_POLL_INTERVAL_MS: optionalPositiveInt,
    WATCHER_MAINTENANCE_TIMEOUT_MS: optionalPositiveInt,

    API_TOKEN: optionalString,
    WATCHER_API_CLIENT_ID: optionalString,
    WATCHER_API_CLIENT_SECRET: optionalString,

    AUTH_REQUIRED: optionalString,
    AUTH_PROVIDER: optionalString,
    AUTH_ISSUER: optionalString,
    AUTH_AUDIENCE: optionalString,
    // Legacy Auth0 names, still honoured as fallbacks for the generic ones above.
    AUTH0_DOMAIN: optionalString,
    AUTH0_ISSUER_BASE_URL: optionalString,
    AUTH0_AUDIENCE: optionalString
  })
  .superRefine((env, ctx) => {
    // A lone credential half is always a misconfiguration, regardless of auth
    // mode: createApiTokenProvider only uses the client-credentials grant when
    // BOTH are present, so a single half silently degrades to "no M2M token".
    const hasClientId = env.WATCHER_API_CLIENT_ID !== undefined;
    const hasClientSecret = env.WATCHER_API_CLIENT_SECRET !== undefined;
    if (hasClientId !== hasClientSecret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasClientId ? "WATCHER_API_CLIENT_SECRET" : "WATCHER_API_CLIENT_ID"],
        message: "WATCHER_API_CLIENT_ID and WATCHER_API_CLIENT_SECRET must be set together"
      });
    }

    // Auth fails CLOSED (see isAuthRequired): required unless an operator
    // EXPLICITLY sets AUTH_REQUIRED=false. In that dev posture localhost defaults
    // and a missing credential are fine — the local API skips token validation.
    // An unrecognised AUTH_PROVIDER is an error in every posture.
    const authRequired = isAuthRequired(env.AUTH_REQUIRED);
    const hasClientCreds = hasClientId && hasClientSecret;

    // The client-credentials grant fetches a token for a specific audience from
    // the provider's token endpoint; a placeholder/missing audience or issuer would
    // fail that fetch on the first claim, so validate them (generic AUTH_* names or
    // their legacy AUTH0_* fallbacks) when that path is used.
    const authIssues = authEnvIssues(env, {
      requireEndpoints: authRequired && hasClientCreds,
      context: "for the watcher's client-credentials grant when auth is enabled"
    });
    for (const issue of authIssues) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [issue.variable], message: issue.message });
    }

    if (!authRequired) {
      return;
    }

    // Production: the localhost fallback for API_BASE_URL is a footgun, so a
    // production watcher (auth on) must name its API explicitly.
    if (env.API_BASE_URL === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["API_BASE_URL"],
        message: "is required when auth is enabled (set AUTH_REQUIRED=false to disable auth for local dev)"
      });
    }

    // Without a credential the watcher sends no Authorization header and 401s
    // every claim against an auth-enabled API — silent forever. Fail fast unless
    // either the M2M client-credentials quad or the legacy static token is set.
    const hasStaticToken = env.API_TOKEN !== undefined;
    if (!hasClientCreds && !hasStaticToken) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["WATCHER_API_CLIENT_ID"],
        message:
          "the watcher needs a credential when auth is enabled: set WATCHER_API_CLIENT_ID + WATCHER_API_CLIENT_SECRET (preferred) or API_TOKEN (set AUTH_REQUIRED=false to disable auth for local dev)"
      });
    }
  });

// Reads and validates the watcher's environment once at startup, returning a
// typed config object. Throws a single aggregated Error naming every offending
// var on invalid/missing-required config. `env` is injectable so tests need not
// mutate process.env.
export function loadWatcherConfig(env: NodeJS.ProcessEnv = process.env): WatcherConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const name = issue.path.join(".") || "(root)";
      return `  - ${name}: ${issue.message}`;
    });
    throw new Error(`Invalid watcher configuration:\n${lines.join("\n")}`);
  }

  const parsed = result.data;
  // Resolve the provider, token endpoint and audience from the same auth settings
  // the API validates against, so the watcher and API agree on all of them.
  const authSettings = authSettingsFromEnv(env);

  return {
    apiBaseUrl: parsed.API_BASE_URL ?? "http://localhost:4000",
    watcherName: parsed.WATCHER_NAME ?? "local-dev-watcher",
    pollIntervalMs: parsed.WATCHER_POLL_INTERVAL_MS ?? 2000,
    maintenanceTimeoutMs: parsed.WATCHER_MAINTENANCE_TIMEOUT_MS ?? 15 * 60_000,
    auth: {
      required: authSettings.required,
      staticToken: parsed.API_TOKEN,
      clientId: parsed.WATCHER_API_CLIENT_ID,
      clientSecret: parsed.WATCHER_API_CLIENT_SECRET,
      provider: authSettings.provider,
      tokenUrl: authSettings.tokenUrl,
      audience: authSettings.audience,
      apiIdUri: authSettings.apiIdUri
    },
    telemetry: resolveTelemetryConfig(env, "watcher")
  };
}
