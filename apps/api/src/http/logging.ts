import { randomUUID } from "node:crypto";
import type { Logger } from "@magpie/logger";
import type { MiddlewareHandler } from "hono";

declare module "hono" {
  interface ContextVariableMap {
    // Set by requestLogging on every request (registered with app.use("*")).
    logger: Logger;
  }
}

// Assigns each request a child logger bound to { requestId, method, path } and
// logs one completion line with status + durationMs. Handlers and onError read
// the request logger via c.get("logger").
//
// requestId identifies this one hop; cross-service correlation is provided by the
// OpenTelemetry trace id (stamped onto every line by the root logger's mixin when
// telemetry is enabled), so no correlation header is handled here.
export function requestLogging(root: Logger): MiddlewareHandler {
  return async (c, next) => {
    const requestId = randomUUID();
    const child = root.child({ requestId, method: c.req.method, path: c.req.path });
    c.set("logger", child);
    const start = Date.now();
    try {
      await next();
    } finally {
      child.info({ status: c.res.status, durationMs: Date.now() - start }, "request");
    }
  };
}
