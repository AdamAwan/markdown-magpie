import { createLogger } from "@magpie/logger";
import { loggerTraceMixin } from "@magpie/telemetry";

// The api's single root logger. Free functions import this directly; the request
// middleware derives per-request child loggers from it. Env is read here, at the
// app boundary, so packages stay env-free.
export const logger = createLogger({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug"),
  pretty: process.env.NODE_ENV !== "production",
  base: { service: "api" },
  // Stamp the active trace's ids onto every line (empty when telemetry is off), so
  // logs join traces in the backend.
  mixin: loggerTraceMixin
});
