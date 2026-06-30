import { createLogger } from "@magpie/logger";

export const logger = createLogger({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug"),
  pretty: process.env.NODE_ENV !== "production",
  base: { service: "watcher" }
});
