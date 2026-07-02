import { createCorrelationStore, type CorrelationStore } from "@magpie/logger";

// The watcher's single correlation-id store. The worker loop binds a job's id
// (inherited from the enqueueing request, or minted when the job originated
// outside a request) for the duration of that job's execution; the HTTP client
// reads it ambiently and sends it on every callback to the API, so the watcher's
// work joins the same cross-service chain. One instance per process.
export const correlation: CorrelationStore = createCorrelationStore();

// The header the id travels on to the API. Must match the API's CORRELATION_HEADER
// so the API's request-logging middleware reuses it instead of minting a new one.
export const CORRELATION_HEADER = "x-correlation-id";
