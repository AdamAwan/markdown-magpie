import pino from "pino";

export type Logger = pino.Logger;

// Internal — not exported. Consumers pass an object literal (structurally typed);
// exporting a type used only here would trip knip's STRICT unused-export check.
interface LoggerOptions {
  /** Minimum level to emit. Defaults to "info". */
  level?: string;
  /** Use the human-readable pino-pretty transport (dev). Ignored when `destination` is set. */
  pretty?: boolean;
  /** Fields merged into every log line (e.g. { service: "api" }). */
  base?: Record<string, unknown>;
  /** Explicit sink (a writable stream, or an fd such as 2 for stderr). Forces raw JSON output. */
  destination?: number | NodeJS.WritableStream;
}

// A thin wrapper over pino. Configuration is passed in by the caller (apps read
// env at their composition root) so this package never touches process.env.
export function createLogger(opts: LoggerOptions = {}): Logger {
  const { level = "info", pretty = false, base, destination } = opts;
  const options: pino.LoggerOptions = { level, base: base ?? undefined };

  if (destination !== undefined) {
    // Explicit sink: raw JSON, no transport. Used by tests and the stdio MCP
    // server (which must keep stdout free for JSON-RPC and log to stderr).
    const stream =
      typeof destination === "number" ? pino.destination({ dest: destination, sync: true }) : destination;
    return pino(options, stream);
  }

  if (pretty) {
    return pino({ ...options, transport: { target: "pino-pretty", options: { colorize: true } } });
  }

  return pino(options);
}
