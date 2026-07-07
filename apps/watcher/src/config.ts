import { z } from "zod";
import { authSettingsFromEnv, isAuthRequired } from "@magpie/auth";
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
    // Derived from the same Auth0 settings the API validates against.
    tokenUrl: string;
    audience: string;
  };
  // OpenTelemetry export. Off unless an OTLP endpoint is configured; resolved via
  // a helper (not the zod schema) because the SDK reads the rest of its own OTEL_* env.
  telemetry: TelemetryConfig;
}

// The committed placeholder audience from .env.example. Real deployments must
// override it; it is rejected at boot when auth is enabled and the M2M
// client-credentials grant is in use (see superRefine), because fetching a token
// for a non-existent audience would fail on the first claim.
const PLACEHOLDER_AUDIENCE = "https://markdown-magpie.local/api";

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
    if (!isAuthRequired(env.AUTH_REQUIRED)) {
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
    const hasClientCreds = hasClientId && hasClientSecret;
    const hasStaticToken = env.API_TOKEN !== undefined;
    if (!hasClientCreds && !hasStaticToken) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["WATCHER_API_CLIENT_ID"],
        message:
          "the watcher needs a credential when auth is enabled: set WATCHER_API_CLIENT_ID + WATCHER_API_CLIENT_SECRET (preferred) or API_TOKEN (set AUTH_REQUIRED=false to disable auth for local dev)"
      });
    }

    // The client-credentials grant fetches a token for a specific audience from
    // the tenant's token endpoint; a placeholder/missing audience or issuer would
    // fail that fetch on the first claim, so validate them when that path is used.
    if (hasClientCreds) {
      if (env.AUTH0_AUDIENCE === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AUTH0_AUDIENCE"],
          message: "is required for the watcher's client-credentials grant when auth is enabled"
        });
      } else if (env.AUTH0_AUDIENCE === PLACEHOLDER_AUDIENCE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AUTH0_AUDIENCE"],
          message: `must be a real Auth0 API identifier, not the placeholder ${PLACEHOLDER_AUDIENCE}`
        });
      }
      if (env.AUTH0_ISSUER_BASE_URL === undefined && env.AUTH0_DOMAIN === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AUTH0_ISSUER_BASE_URL"],
          message: "AUTH0_ISSUER_BASE_URL or AUTH0_DOMAIN is required for the watcher's client-credentials grant when auth is enabled"
        });
      }
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
  // Resolve the token endpoint and audience from the same Auth0 settings the API
  // validates against, so the watcher and API agree on both.
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
      tokenUrl: `${authSettings.issuer}oauth/token`,
      audience: authSettings.audience
    },
    telemetry: resolveTelemetryConfig(env, "watcher")
  };
}
