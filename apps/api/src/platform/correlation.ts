import { createCorrelationStore, type CorrelationStore } from "@magpie/logger";

// The API's single correlation-id store. The request-logging middleware binds an
// id (from an inbound x-correlation-id header, or freshly minted) for the lifetime
// of each request; deep callees read it ambiently — most importantly the job
// broker, which stamps it onto every job it enqueues so the id follows the work
// out to the watcher and back. One instance per process (see createCorrelationStore).
export const correlation: CorrelationStore = createCorrelationStore();

// The header the id travels on, in and out of the API. The watcher sends it on its
// callbacks so a request → job → watcher → callback chain shares one id; the API
// echoes it on responses so a caller can correlate too.
export const CORRELATION_HEADER = "x-correlation-id";
