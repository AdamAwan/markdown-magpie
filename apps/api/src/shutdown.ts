import { createServer, type RequestListener, type Server, type ServerResponse } from "node:http";
import type { Logger } from "@magpie/logger";

// Graceful API shutdown (docs/api.md API37/API38). A deploy or restart sends
// SIGTERM; the API must not drop requests it already accepted, nor tear the pool
// down under a handler or background task that is still using it. The sequence:
//
//   1. stop accepting connections and wait for in-flight HTTP handlers to finish
//      (idle keep-alive sockets are closed at once; anything still open when the
//      drain window ends is force-closed);
//   2. wait for in-process background work (merge cascades, manual task runs) —
//      the SAME drain window, so the total stays bounded by drainMs;
//   3. run the teardown steps in order (job broker, then the store pool, then
//      telemetry), each independently, so one failing never skips the next;
//   4. exit.
//
// A second SIGTERM/SIGINT while draining exits immediately (an operator's
// "really stop"), and a hard backstop exits if teardown itself hangs.

interface ShutdownStep {
  name: string;
  run: () => Promise<unknown>;
}

export interface GracefulShutdownOptions {
  server: DrainableServer;
  // The one drain window shared by the HTTP drain and the background drain.
  drainMs: number;
  // How long teardown (the steps) may take after the drain before the backstop
  // forces exit. Defaults to 10s.
  teardownMs?: number;
  background: { whenIdle(): Promise<void>; readonly pending: number };
  steps: ShutdownStep[];
  logger: Logger;
  exit: (code: number) => void;
  // Where SIGTERM/SIGINT arrive; process in production, an emitter in tests.
  signals: Pick<NodeJS.EventEmitter, "on">;
}

const DEFAULT_TEARDOWN_MS = 10_000;

export interface DrainableServer {
  readonly server: Server;
  // Stops accepting connections and resolves once every connection has ended —
  // or, at the deadline, force-closes whatever is still open (a handler that
  // outlived the window, e.g. a long-poll) and resolves "forced".
  drain(timeoutMs: number): Promise<"drained" | "forced">;
}

// A node:http server that can drain. server.close() alone waits on keep-alive
// sockets: Node closes the ones idle at that moment, but a socket whose request
// is still in flight stays open after its response, until the client's
// keep-alive timeout. So the server tracks its in-flight responses, and while
// draining marks each one not yet sent `Connection: close` (Node then ends the
// socket after the response, and the client knows to reconnect elsewhere); a
// response whose headers already went out closes its socket once it finishes.
export function createDrainableServer(listener: RequestListener): DrainableServer {
  const inFlight = new Set<ServerResponse>();
  let draining = false;

  const closeAfter = (res: ServerResponse): void => {
    if (!res.headersSent) {
      res.setHeader("connection", "close");
    }
  };

  const server = createServer((req, res) => {
    inFlight.add(res);
    res.on("close", () => {
      inFlight.delete(res);
      // The socket is marked idle only after the response's close; defer a tick.
      if (draining) setImmediate(() => server.closeIdleConnections());
    });
    if (draining) closeAfter(res);
    listener(req, res);
  });

  return {
    server,
    drain(timeoutMs) {
      draining = true;
      for (const res of inFlight) closeAfter(res);
      return new Promise((resolve) => {
        let forced = false;
        const timer = setTimeout(() => {
          forced = true;
          server.closeAllConnections();
        }, timeoutMs);
        server.close(() => {
          clearTimeout(timer);
          resolve(forced ? "forced" : "drained");
        });
        server.closeIdleConnections();
      });
    }
  };
}

// Resolves when `work` settles or `ms` elapses, whichever is first. `true` iff
// the work settled in time.
async function within(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, ms));
  });
  try {
    return await Promise.race([work.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function installGracefulShutdown(options: GracefulShutdownOptions): void {
  const { server, drainMs, background, steps, logger, exit, signals } = options;
  const teardownMs = options.teardownMs ?? DEFAULT_TEARDOWN_MS;
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    const deadline = Date.now() + drainMs;
    logger.info({ signal, drainMs }, "received signal; draining HTTP requests and background work before exit");

    const http = await server.drain(drainMs);
    if (http === "forced") {
      logger.warn({ drainMs }, "HTTP drain window elapsed; force-closed the remaining connections");
    }
    const idle = await within(background.whenIdle(), deadline - Date.now());
    if (!idle) {
      logger.warn({ pending: background.pending }, "exiting with background tasks still in flight");
    }

    for (const step of steps) {
      try {
        await step.run();
      } catch (error) {
        logger.warn(
          { step: step.name, err: error instanceof Error ? error.message : "Unknown error" },
          "shutdown step failed; continuing"
        );
      }
    }
    exit(0);
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      logger.warn({ signal }, "second shutdown signal; exiting immediately");
      exit(1);
      return;
    }
    shuttingDown = true;
    // Backstop: a teardown step that hangs (an unreachable database on pool.end)
    // must not hold the process until the orchestrator's SIGKILL.
    setTimeout(() => {
      logger.error({ signal }, "graceful shutdown did not finish in time; forcing exit");
      exit(1);
    }, drainMs + teardownMs).unref();
    void shutdown(signal);
  };

  signals.on("SIGTERM", () => onSignal("SIGTERM"));
  signals.on("SIGINT", () => onSignal("SIGINT"));
}
