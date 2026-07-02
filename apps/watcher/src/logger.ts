import { createLogger } from "@magpie/logger";
import { loggerTraceMixin } from "@magpie/telemetry";

export const logger = createLogger({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug"),
  pretty: process.env.NODE_ENV !== "production",
  base: { service: "watcher" },
  // Stamp the active trace's ids onto every line (empty when telemetry is off), so
  // a job's logs join its trace in the backend.
  mixin: loggerTraceMixin
});
