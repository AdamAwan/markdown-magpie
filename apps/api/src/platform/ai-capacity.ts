import { AI_JOB_TYPES, INTERACTIVE_AI_JOB_TYPES } from "@magpie/jobs";
import type { AppContext } from "../context.js";
import type { InFlightCapacity } from "../jobs/broker.js";
import { HttpError } from "../http/errors.js";
import { logger } from "../logger.js";

// Global admission control for metered AI work, split into policy (what the
// capacity is) and action (assert / build the rejection) so the atomic admission
// primitive and the cheap pre-check share one source of truth.
//
// The gate is class-aware (#240): an interactive request is rejected only when
// BOTH the interactive lane's reserved slots are taken (in-flight interactive
// jobs >= the reserve) AND the global ceiling is reached (in-flight AI jobs of
// any class >= the limit). Maintenance fan-out counts toward the global ceiling
// but can never occupy the reserve, so a patrol burst can no longer push
// /api/ask into 429.
//
// Maintenance fan-out is now ALSO admission-controlled (#288b): it admits through
// the same atomic primitive but under the STRICTER nonInteractiveAiCapacity below
// — rejected once the global count reaches `limit - reserved`, so the interactive
// reserve is always left free. Both policies share one limit/reserved computation
// (aiCapacityBounds) so the two classes can never drift apart.
//
// The enqueue path itself is now ATOMIC (#288a): POST /api/ask admits through
// JobBroker.createIfAdmitted, which counts and enqueues under one advisory lock,
// so concurrent asks can no longer overshoot the ceiling. assertAiCapacity below
// remains as a cheap, non-atomic pre-check (a load-shedding optimization that
// rejects a saturated system before any log row is written) — see
// docs/rate-limiting.md.

// The shared limit/reserved math for BOTH admission policies (interactive and
// non-interactive), or undefined when rate limiting is disabled (a pass-through —
// no ceiling to enforce). Centralised here so the two builders below can never
// drift on how the ceiling and the reserve are derived from config.
function aiCapacityBounds(ctx: AppContext): { limit: number; reserved: number } | undefined {
  const settings = ctx.settings.rateLimit;
  if (!settings.enabled) {
    return undefined;
  }
  const limit = settings.aiMaxInflightJobs;
  // A reserve above the ceiling would make interactive admission unbounded (both
  // conditions could never hold together), so clamp it to the ceiling.
  const reserved = Math.min(settings.aiInteractiveReservedJobs, limit);
  return { limit, reserved };
}

// The capacity envelope for interactive AI admission, or undefined when rate
// limiting is disabled. An interactive enqueue is shed only when its reserved
// lane is full AND the global ceiling is reached (see the reserve rule).
export function aiInflightCapacity(ctx: AppContext): InFlightCapacity | undefined {
  const bounds = aiCapacityBounds(ctx);
  if (!bounds) {
    return undefined;
  }
  return {
    types: [...AI_JOB_TYPES],
    limit: bounds.limit,
    reserve: { types: [...INTERACTIVE_AI_JOB_TYPES], reserved: bounds.reserved }
  };
}

// Non-interactive (maintenance + questionnaire batch) admission policy: strictly
// under the global ceiling, always leaving the interactive reserve free. Rejects
// iff inFlight >= limit - reserved. There is no `reserve` lane — the reserve is
// carved out by lowering the effective limit — so createIfAdmitted's block rule
// reduces to the simple `inFlight >= capacity.limit`. Returns undefined when rate
// limiting is disabled (a pass-through). This IS the maintenance admission rule
// (#288b); sub-item (c) reuses it for the questionnaire answer batch.
export function nonInteractiveAiCapacity(ctx: AppContext): InFlightCapacity | undefined {
  const bounds = aiCapacityBounds(ctx);
  if (!bounds) {
    return undefined;
  }
  return {
    types: [...AI_JOB_TYPES],
    limit: Math.max(0, bounds.limit - bounds.reserved)
  };
}

// Builds the 429 `ai_capacity` HttpError (with a Retry-After header) for observed
// in-flight counts, and emits the structured `ai_capacity`/`blocked` warn log the
// dashboards consume. Callers pass the counts they observed — the atomic path the
// ones seen under the lock, the pre-check the ones it just read — so the log and
// the response always reflect the real decision. `reserveInFlight` is logged as
// `interactiveInFlight` for continuity with the existing event.
export function aiCapacityError(ctx: AppContext, observed: { inFlight: number; reserveInFlight: number }): HttpError {
  const settings = ctx.settings.rateLimit;
  const limit = settings.aiMaxInflightJobs;
  const reserved = Math.min(settings.aiInteractiveReservedJobs, limit);
  const retryAfterSeconds = Math.max(1, Math.ceil(settings.windowMs / 1000));
  logger.warn(
    {
      event: "ai_capacity",
      decision: "blocked",
      inFlight: observed.inFlight,
      interactiveInFlight: observed.reserveInFlight,
      limit,
      reserved,
      retryAfterSeconds
    },
    "ai capacity exceeded"
  );
  return new HttpError(429, "ai_capacity", `Too many AI jobs in flight (${observed.inFlight}/${limit})`, {
    "Retry-After": String(retryAfterSeconds)
  });
}

// Cheap, non-atomic pre-check. Call immediately before recording any log/run row
// so a saturated system sheds load before writing state. External behavior is
// unchanged: it throws the same 429 `ai_capacity` error at the same threshold as
// before. The authoritative, race-free gate is createIfAdmitted at enqueue time;
// this only avoids churn on an already-full system.
export async function assertAiCapacity(ctx: AppContext): Promise<void> {
  const capacity = aiInflightCapacity(ctx);
  if (!capacity) {
    return;
  }
  const reserve = capacity.reserve;
  const [inFlight, reserveInFlight] = await Promise.all([
    ctx.jobs.countInFlight(capacity.types),
    reserve ? ctx.jobs.countInFlight(reserve.types) : Promise.resolve(0)
  ]);

  // The same block rule createIfAdmitted evaluates under the lock.
  const blocked = reserve
    ? reserveInFlight >= reserve.reserved && inFlight >= capacity.limit
    : inFlight >= capacity.limit;
  if (blocked) {
    throw aiCapacityError(ctx, { inFlight, reserveInFlight });
  }

  logger.debug(
    {
      event: "ai_capacity",
      decision: "allowed",
      inFlight,
      interactiveInFlight: reserveInFlight,
      limit: capacity.limit,
      reserved: reserve?.reserved ?? 0
    },
    "ai capacity ok"
  );
}
