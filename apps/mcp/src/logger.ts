import { createLogger, type Logger } from "@magpie/logger";

// stdio MCP multiplexes JSON-RPC over stdout, so its logs MUST go to stderr
// (fd 2). The http transport is a normal server process and logs to stdout.
export function createMcpLogger(transport: "http" | "stdio"): Logger {
  const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug");
  const base = { service: "mcp", transport };
  if (transport === "stdio") {
    return createLogger({ level, base, destination: 2 });
  }
  return createLogger({ level, base, pretty: process.env.NODE_ENV !== "production" });
}
