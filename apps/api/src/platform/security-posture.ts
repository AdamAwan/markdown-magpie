import type { Logger } from "@magpie/logger";
import { PRODUCTION_OVERRIDE_ENV, STORE_ENV_NAMES, type AppConfig, type StoreEnvName } from "./config.js";
import { storeBackend } from "./stores.js";

// The security-relevant facts about the configuration the API booted with, in one
// structured record so an operator (or a log alert) can see at a glance whether a
// deployment is authenticated, durable and origin-restricted.
export interface SecurityPosture {
  nodeEnv: string;
  auth: { required: boolean; provider: string; issuer?: string; audience?: string };
  // The stores whose effective backend (override, else STORAGE_BACKEND) is memory.
  storage: { default: string; memoryStores: StoreEnvName[] };
  cors: { allowedOrigins: "*" | string[] };
  // The MAGPIE_ALLOW_* production overrides in effect (names only).
  productionOverrides: string[];
}

export function securityPosture(config: AppConfig): SecurityPosture {
  const memoryStores = STORE_ENV_NAMES.filter((name) => storeBackend(config, name) === "memory");
  return {
    nodeEnv: config.nodeEnv,
    auth: {
      required: config.auth.required,
      provider: config.auth.provider,
      ...(config.auth.required && config.auth.issuer ? { issuer: config.auth.issuer } : {}),
      ...(config.auth.required && config.auth.audience ? { audience: config.auth.audience } : {})
    },
    storage: { default: config.storage.default, memoryStores },
    cors: { allowedOrigins: config.cors.allowedOrigins },
    productionOverrides: (Object.keys(PRODUCTION_OVERRIDE_ENV) as Array<keyof typeof PRODUCTION_OVERRIDE_ENV>)
      .filter((key) => config.productionOverrides[key])
      .map((key) => PRODUCTION_OVERRIDE_ENV[key])
  };
}

// Logs the security posture once at startup, unconditionally (unlike the opt-out
// LOG_STARTUP_CONFIG dump): one info line always, plus a warning per insecure
// posture so a disabled-auth or in-memory deployment is impossible to miss in the
// logs. Production refuses these postures at loadConfig unless overridden, so in
// production the warnings only ever fire for a deliberate override.
export function logSecurityPosture(config: AppConfig, log: Logger): SecurityPosture {
  const posture = securityPosture(config);
  log.info({ event: "security_posture", ...posture }, "API security posture");
  if (!posture.auth.required) {
    log.warn(
      { event: "security_posture", auth: "disabled" },
      "AUTH IS DISABLED (AUTH_REQUIRED=false): every API route accepts unauthenticated requests. Local development only."
    );
  }
  if (posture.storage.memoryStores.length > 0) {
    log.warn(
      { event: "security_posture", storage: posture.storage },
      "In-memory storage is configured: that data is lost when the API restarts."
    );
  }
  if (posture.cors.allowedOrigins === "*") {
    log.warn(
      { event: "security_posture", cors: "*" },
      "CORS allows any origin: set CORS_ALLOWED_ORIGINS to the console origin(s) for a deployed instance."
    );
  }
  if (posture.productionOverrides.length > 0) {
    log.warn(
      { event: "security_posture", productionOverrides: posture.productionOverrides },
      `Production safety checks overridden: ${posture.productionOverrides.join(", ")}`
    );
  }
  return posture;
}
