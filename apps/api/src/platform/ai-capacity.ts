import { AI_JOB_TYPES } from "@magpie/jobs";
import type { AppContext } from "../context.js";
import { HttpError } from "../http/errors.js";
import { logger } from "../logger.js";

// Global admission control for metered AI work. Call this immediately before
// enqueuing (or kicking off orchestration that fans out into) AI jobs, and
// crucially BEFORE persisting any log/run row, so a rejection never orphans
// state. When the number of in-flight (created|retry|active) AI jobs is at or
// above the configured ceiling it throws HttpError(429, "ai_capacity") with a
// Retry-After header: we shed load rather than defer unbounded cost. The
// decision is logged as a structured `ai_capacity` event for dashboards — see
// docs/rate-limiting.md.
export async function assertAiCapacity(ctx: AppContext): Promise<void> {
  const settings = ctx.settings.rateLimit;
  if (!settings.enabled) {
    return;
  }

  const limit = settings.aiMaxInflightJobs;
  const inFlight = await ctx.jobs.countInFlight([...AI_JOB_TYPES]);

  if (inFlight >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil(settings.windowMs / 1000));
    logger.warn(
      { event: "ai_capacity", decision: "blocked", inFlight, limit, retryAfterSeconds },
      "ai capacity exceeded"
    );
    throw new HttpError(429, "ai_capacity", `Too many AI jobs in flight (${inFlight}/${limit})`, {
      "Retry-After": String(retryAfterSeconds)
    });
  }

  logger.debug({ event: "ai_capacity", decision: "allowed", inFlight, limit }, "ai capacity ok");
}
