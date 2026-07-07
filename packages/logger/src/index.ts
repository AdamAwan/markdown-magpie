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
  /**
   * Called per log line; its return value is merged onto that line. Used to stamp
   * dynamic context (e.g. the active trace id) without binding it per-logger.
   */
  mixin?: () => Record<string, unknown>;
}

// A thin wrapper over pino. Configuration is passed in by the caller (apps read
// env at their composition root) so this package never touches process.env.
export function createLogger(opts: LoggerOptions = {}): Logger {
  const { level = "info", pretty = false, base, destination, mixin } = opts;
  // Omit `base` when unset so pino keeps its default base (pid, hostname).
  const options: pino.LoggerOptions = { level, base, mixin };

  if (destination !== undefined) {
    // Explicit sink: raw JSON, no transport. Used by tests and the stdio MCP
    // server (which must keep stdout free for JSON-RPC and log to stderr).
    const stream = typeof destination === "number" ? pino.destination({ dest: destination, sync: true }) : destination;
    return pino(options, stream);
  }

  if (pretty) {
    return pino({ ...options, transport: { target: "pino-pretty", options: { colorize: true } } });
  }

  return pino(options);
}

// Longest we wait for the logger to flush its buffered output before exiting
// anyway. A wedged transport must never leave the crashed process hanging.
const FLUSH_TIMEOUT_MS = 1_000;

// Registers process-level handlers for the two failure modes Node would otherwise
// print as a bare stderr trace and (by default) terminate on: an uncaught
// exception and an unhandled promise rejection. Each is logged fatally — through
// the same structured pipeline as everything else, so the crash carries context
// (service, err, stack) into the log aggregator — then the process exits non-zero
// so the orchestrator's restart policy takes over. Call once, at the composition
// root, before any real work starts.
//
// `exit` is injectable purely so tests can assert the exit code without tearing
// down the test runner; production always uses the real process.exit.
export function installCrashHandlers(
  logger: Logger,
  exit: (code: number) => void = (code) => process.exit(code)
): void {
  const onFatal = createFatalHandler(logger, exit);
  process.on("uncaughtException", (error) => onFatal("uncaughtException", error));
  process.on("unhandledRejection", (reason) => onFatal("unhandledRejection", reason));
}

// The crash-handling core, split out from the process wiring so it can be tested
// directly — emitting real `uncaughtException`/`unhandledRejection` events would
// trip the test runner's own global guards. Returns a handler that logs the
// failure fatally, flushes best-effort, and exits non-zero exactly once.
export function createFatalHandler(
  logger: Logger,
  exit: (code: number) => void
): (event: "uncaughtException" | "unhandledRejection", value: unknown) => void {
  let handling = false;
  return (event, value) => {
    // A throw inside the handler, or a second failure racing the first, must not
    // re-enter: the first fatal wins and drives the single exit.
    if (handling) {
      return;
    }
    handling = true;
    logger.fatal({ err: normalizeError(value), event }, `fatal ${event}; exiting`);
    // Flush best-effort so the fatal line reaches the sink before exit, but never
    // hang on it — a bounded fallback exits even if the flush callback never fires.
    let exited = false;
    const finish = (): void => {
      if (exited) {
        return;
      }
      exited = true;
      exit(1);
    };
    const timer = setTimeout(finish, FLUSH_TIMEOUT_MS);
    timer.unref();
    logger.flush(() => finish());
  };
}

// A rejection can carry any value, not just an Error. Wrap non-Errors so the log
// always has a message and the pino error serializer has something to work with.
function normalizeError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(`Non-error thrown: ${safeStringify(value)}`);
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
