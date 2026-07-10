import { AI_JOB_TYPES, INTERACTIVE_AI_JOB_TYPES } from "@magpie/jobs";
import type { AppContext } from "../context.js";
import { HttpError } from "../http/errors.js";
import { logger } from "../logger.js";

// Global admission control for metered AI work. Call this immediately before
// enqueuing (or kicking off orchestration that fans out into) AI jobs, and
// crucially BEFORE persisting any log/run row, so a rejection never orphans
// state. When capacity is exhausted it throws HttpError(429, "ai_capacity")
// with a Retry-After header: we shed load rather than defer unbounded cost.
//
// This gate guards the interactive enqueue paths (POST /api/ask today), and
// class-aware counting is what keeps interactive headroom real (#240): an
// interactive request is rejected only when BOTH the interactive lane's
// reserved slots are taken (in-flight interactive jobs >= the reserve) AND the
// global ceiling is reached (in-flight AI jobs of any class >= the limit).
// Maintenance fan-out is not admission-controlled yet (see docs/rate-limiting.md),
// so an hourly patrol burst can exceed the global ceiling on its own — but
// because it can never occupy the reserve, it can no longer push /api/ask into
// 429. The decision is logged as a structured `ai_capacity` event for
// dashboards — see docs/rate-limiting.md.
export async function assertAiCapacity(ctx: AppContext): Promise<void> {
  const settings = ctx.settings.rateLimit;
  if (!settings.enabled) {
    return;
  }

  const limit = settings.aiMaxInflightJobs;
  // A reserve above the ceiling would make interactive admission unbounded
  // (both conditions could never hold together), so clamp it to the ceiling.
  const reserved = Math.min(settings.aiInteractiveReservedJobs, limit);
  const [inFlight, interactiveInFlight] = await Promise.all([
    ctx.jobs.countInFlight([...AI_JOB_TYPES]),
    ctx.jobs.countInFlight([...INTERACTIVE_AI_JOB_TYPES])
  ]);

  if (interactiveInFlight >= reserved && inFlight >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil(settings.windowMs / 1000));
    logger.warn(
      { event: "ai_capacity", decision: "blocked", inFlight, interactiveInFlight, limit, reserved, retryAfterSeconds },
      "ai capacity exceeded"
    );
    throw new HttpError(429, "ai_capacity", `Too many AI jobs in flight (${inFlight}/${limit})`, {
      "Retry-After": String(retryAfterSeconds)
    });
  }

  logger.debug(
    { event: "ai_capacity", decision: "allowed", inFlight, interactiveInFlight, limit, reserved },
    "ai capacity ok"
  );
}
