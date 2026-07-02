import { randomUUID } from "node:crypto";
import type { Logger } from "@magpie/logger";
import type { MiddlewareHandler } from "hono";
import { CORRELATION_HEADER, correlation } from "../platform/correlation.js";

declare module "hono" {
  interface ContextVariableMap {
    // Set by requestLogging on every request (registered with app.use("*")).
    logger: Logger;
  }
}

// Assigns each request a child logger bound to { requestId, correlationId, method,
// path } and logs one completion line with status + durationMs. Handlers and
// onError read the request logger via c.get("logger").
//
// requestId identifies this one hop; correlationId threads a whole cross-service
// chain (request → enqueued job → watcher execution → API callback). An inbound
// x-correlation-id is reused so a continuing chain keeps its id; otherwise one is
// minted here. The id is bound into an AsyncLocalStorage scope for the request so
// deep callees (the job broker) can stamp it without it being passed explicitly,
// and echoed on the response header so callers can correlate too.
export function requestLogging(root: Logger): MiddlewareHandler {
  return async (c, next) => {
    const requestId = randomUUID();
    const correlationId = c.req.header(CORRELATION_HEADER)?.trim() || requestId;
    const child = root.child({ requestId, correlationId, method: c.req.method, path: c.req.path });
    c.set("logger", child);
    c.header(CORRELATION_HEADER, correlationId);
    const start = Date.now();
    try {
      await correlation.run(correlationId, () => next());
    } finally {
      child.info({ status: c.res.status, durationMs: Date.now() - start }, "request");
    }
  };
}
