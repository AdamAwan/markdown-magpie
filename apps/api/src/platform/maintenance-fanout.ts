import type { JobType, JobView } from "@magpie/jobs";
import type { AppContext } from "../context.js";
import { nonInteractiveAiCapacity } from "./ai-capacity.js";
import { logger } from "../logger.js";

// The single funnel every maintenance AI enqueue passes through (#288b). A
// per-tick budget object created once per patrol/reconciler run (after the run
// lock) and threaded to every site that would otherwise call ctx.jobs.create for
// metered work. It layers TWO bounds on maintenance fan-out:
//
//   1. a LOCAL per-tick budget (maintenanceMaxAiJobsPerTick) — free to consult,
//      caps how much a single tick can enqueue even when capacity is wide open;
//   2. the GLOBAL non-interactive admission ceiling — the atomic
//      createIfAdmitted(nonInteractiveAiCapacity(ctx)) round-trip, which shares
//      the same advisory lock as interactive /api/ask admission so the two
//      classes contend on one mutually-exclusive count and maintenance can never
//      occupy the interactive reserve.
//
// admit() checks the free local budget FIRST, then (only if it has budget) makes
// the one atomic admission round-trip. This is the ONE place `class:
// non-interactive` + the budget live — no enqueue site re-derives the rule; each
// simply defers its unit of work on a `{ ok: false }`.

export interface FanoutBudgetCounts {
  taskType: string;
  flowId: string;
  attempted: number;
  enqueued: number;
  deferredByBudget: number;
  rejectedByCapacity: number;
  budget: number;
  runaway: boolean;
}

type FanoutAdmission = { ok: true; job: JobView } | { ok: false; reason: "budget_exhausted" | "capacity" };

export interface FanoutBudget {
  // Try to enqueue one maintenance AI job. Order: the free local per-tick budget
  // first (→ "budget_exhausted" when spent), then the atomic non-interactive
  // admission (→ "capacity" when the global ceiling rejects). Only an admitted
  // enqueue decrements the budget, so a capacity rejection leaves the budget for a
  // later admit in the same tick. When rate limiting is disabled the admission
  // step is a plain ctx.jobs.create pass-through and only the budget applies.
  admit(type: JobType, input: unknown): Promise<FanoutAdmission>;
  // Emit the summary `maintenance_fanout` event (debug on a clean tick, warn — and
  // `runaway` past the alert threshold — when any shedding occurred).
  finish(): void;
  // The running counters, for surfacing onto the tick's MaintenanceRun.details.
  snapshot(): FanoutBudgetCounts;
}

export function createFanoutBudget(ctx: AppContext, taskType: string, flowId?: string): FanoutBudget {
  const budget = Math.max(0, ctx.settings.rateLimit.maintenanceMaxAiJobsPerTick);
  const alertDeferred = ctx.settings.rateLimit.maintenanceFanoutAlertDeferred;
  const flowLabel = flowId ?? "default";

  let remaining = budget;
  let attempted = 0;
  let enqueued = 0;
  let deferredByBudget = 0;
  let rejectedByCapacity = 0;

  const isRunaway = (): boolean => deferredByBudget + rejectedByCapacity >= alertDeferred;

  const snapshot = (): FanoutBudgetCounts => ({
    taskType,
    flowId: flowLabel,
    attempted,
    enqueued,
    deferredByBudget,
    rejectedByCapacity,
    budget,
    runaway: isRunaway()
  });

  return {
    async admit(type, input) {
      attempted += 1;
      // 1) Local per-tick budget — free, so it gates before any admission I/O.
      if (remaining <= 0) {
        deferredByBudget += 1;
        return { ok: false as const, reason: "budget_exhausted" as const };
      }
      // 2) Global non-interactive admission (atomic count+enqueue under the shared
      // AI-admission advisory lock). Undefined capacity ⇒ rate limiting off ⇒
      // plain create pass-through, so local dev keeps enqueueing while still
      // honouring the per-tick budget.
      const capacity = nonInteractiveAiCapacity(ctx);
      if (!capacity) {
        const job = await ctx.jobs.create(type, input);
        remaining -= 1;
        enqueued += 1;
        return { ok: true as const, job };
      }
      const result = await ctx.jobs.createIfAdmitted(type, input, capacity);
      if (!result.admitted || !result.job) {
        rejectedByCapacity += 1;
        return { ok: false as const, reason: "capacity" as const };
      }
      remaining -= 1;
      enqueued += 1;
      return { ok: true as const, job: result.job };
    },
    finish() {
      const shed = deferredByBudget + rejectedByCapacity;
      const runaway = isRunaway();
      const decision = shed > 0 ? "capped" : "ok";
      const event = {
        event: "maintenance_fanout",
        taskType,
        flowId: flowLabel,
        attempted,
        enqueued,
        deferredByBudget,
        rejectedByCapacity,
        budget,
        decision,
        ...(runaway ? { runaway: true } : {})
      };
      if (decision === "capped") {
        logger.warn(
          event,
          runaway
            ? "maintenance fan-out RUNAWAY: shedding far past budget — a patrol is fanning out well beyond its cap"
            : "maintenance fan-out capped: deferred some enqueues this tick (budget or capacity)"
        );
      } else {
        logger.debug(event, "maintenance fan-out within budget");
      }
    },
    snapshot
  };
}
