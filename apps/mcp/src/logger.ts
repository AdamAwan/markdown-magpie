import { createLogger, type Logger } from "@magpie/logger";

// fd 2 (stderr) for stdio so the JSON-RPC stdout channel stays clean; stdout for http.
export function mcpLogDestination(transport: "http" | "stdio"): number | undefined {
  return transport === "stdio" ? 2 : undefined;
}

// stdio MCP multiplexes JSON-RPC over stdout, so its logs MUST go to stderr
// (fd 2). The http transport is a normal server process and logs to stdout.
export function createMcpLogger(transport: "http" | "stdio"): Logger {
  const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug");
  const base = { service: "mcp", transport };
  const destination = mcpLogDestination(transport);
  if (destination !== undefined) {
    return createLogger({ level, base, destination });
  }
  return createLogger({ level, base, pretty: process.env.NODE_ENV !== "production" });
}
