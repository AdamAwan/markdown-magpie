import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppContext } from "../../context.js";
import { requireScopes, requireServicePrincipal } from "../../auth/middleware.js";
import { requirePrivilege } from "../../auth/capabilities.js";
import { HttpError } from "../../http/errors.js";
import { readJsonBody } from "../../http/body.js";
import { JobNotFoundError } from "../../jobs/broker.js";
import * as jobsService from "./service.js";
import {
  claimJobBodySchema,
  completeJobBodySchema,
  createJobBodySchema,
  failJobBodySchema,
  heartbeatJobBodySchema,
  listJobsQuerySchema,
  releaseJobBodySchema
} from "./schema.js";

export function jobRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.post(
    "/",
    requireScopes("manage:jobs"),
    requirePrivilege(ctx, "ops"),
    zValidator("json", createJobBodySchema, (result, c) => {
      if (!result.success) return c.json({ error: "invalid_job" }, 400);
    }),
    async (c) => {
      const { type, input } = c.req.valid("json");
      return c.json({ job: await jobsService.submitJob(ctx, type, input) }, 202);
    }
  );

  app.get("/", requireScopes("read:knowledge"), async (c) => {
    const parsed = listJobsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new HttpError(400, "invalid_job_filters");
    return c.json(await jobsService.listJobs(ctx, parsed.data));
  });

  app.get("/schedules", requireScopes("read:knowledge"), async (c) =>
    c.json({ schedules: await ctx.jobs.listSchedules() })
  );

  // The watcher's job-lifecycle endpoints (claim / heartbeat / complete / fail)
  // are restricted to service principals: a human ops admin holds manage:jobs
  // too, and must not claim jobs (reading their inputs) or forge outcomes for
  // them. No-op when auth is disabled. See docs/authorization.md AZ29.
  app.post(
    "/claim",
    requireScopes("manage:jobs"),
    requireServicePrincipal(),
    zValidator("json", claimJobBodySchema, (result, c) => {
      if (!result.success) return c.json({ error: "worker_capabilities_required" }, 400);
    }),
    async (c) => {
      const { workerName, capabilities } = c.req.valid("json");
      const job = await jobsService.claimJob(ctx, workerName, capabilities);
      return c.json({ job: job ?? null });
    }
  );

  app.get("/:id/wait", requireScopes("read:knowledge"), async (c) => {
    // The request's own abort signal fires when the client disconnects, which
    // ends the long-poll instead of polling for the rest of the wait timeout.
    const signal = c.req.raw.signal;
    try {
      const result = await jobsService.waitForJob(ctx, c.req.param("id"), { signal });
      return c.json({ job: result.job }, result.terminal ? 200 : 202);
    } catch {
      if (signal.aborted) {
        // Nobody is listening; answer without a body rather than a misleading 404.
        return c.body(null, 204);
      }
      throw new HttpError(404, "job_not_found");
    }
  });

  // `active: false` tells the watcher it no longer holds the job (J60) — it
  // aborts the run and reports nothing further. `cancelled` is kept for older
  // watchers, which only abort on it. Only an unknown id is a 404 (API31): any
  // other error is a 500 the watcher's next beat retries.
  app.post("/:id/heartbeat", requireScopes("manage:jobs"), requireServicePrincipal(), async (c) => {
    const parsed = heartbeatJobBodySchema.safeParse(await readJsonBody(c));
    const workerName = parsed.success ? parsed.data.workerName : undefined;
    const attempt = parsed.success ? parsed.data.attempt : undefined;
    const { job, active } = await notFoundAs404(() =>
      jobsService.heartbeatJob(ctx, c.req.param("id"), workerName, attempt === undefined ? {} : { attempt })
    );
    return c.json({ job, cancelled: job.state === "cancelled", active });
  });

  // A watcher draining for shutdown gives its claimed job back to the queue
  // without spending a retry (J53, API36). Service-only like the rest of the
  // lifecycle: a human must not be able to bounce another worker's job.
  app.post("/:id/release", requireScopes("manage:jobs"), requireServicePrincipal(), async (c) => {
    const parsed = releaseJobBodySchema.safeParse(await readJsonBody(c));
    const workerName = parsed.success ? parsed.data.workerName : undefined;
    const attempt = parsed.success ? parsed.data.attempt : undefined;
    try {
      return c.json({
        job: await jobsService.releaseJob(ctx, c.req.param("id"), workerName, attempt === undefined ? {} : { attempt })
      });
    } catch {
      throw new HttpError(404, "job_not_found");
    }
  });

  app.post(
    "/:id/complete",
    requireScopes("manage:jobs"),
    requireServicePrincipal(),
    zValidator("json", completeJobBodySchema, (result, c) => {
      if (!result.success) return c.json({ error: "invalid_output" }, 400);
    }),
    async (c) => {
      const { output, executor, usage, provider, model, attempt } = c.req.valid("json");
      try {
        const outcome = await jobsService.completeJob(
          ctx,
          c.req.param("id"),
          output,
          executor,
          usage,
          {
            ...(provider ? { provider } : {}),
            ...(model ? { model } : {})
          },
          attempt === undefined ? {} : { attempt }
        );
        if (!outcome.ok) {
          // side_effects_failed is a 500 ON PURPOSE: the job's output is already
          // durably persisted (completeJob persists before the side-effect
          // fan-out), so the watcher's complete() retry loop re-POSTing on this
          // 5xx cannot re-run the generation — the retry hits completeJob's
          // replay branch and re-runs only the side effects. That makes a
          // transient side-effect failure self-healing. If retries exhaust and
          // the watcher falls back to fail(), pg-boss no-ops the fail on the
          // completed row, so the output still survives.
          // repair_enqueued and invalid_output both map to 400: a deterministic
          // 4xx is final on the watcher side (it won't locally re-POST), so for a
          // repair the API's own active->retry is the sole re-dispatch (#288d).
          // job_not_active (J62) is a 409 like job_cancelled: the completion did
          // not persist because this attempt no longer holds the job, and no
          // retry of it can change that.
          const status =
            outcome.code === "job_not_found"
              ? 404
              : outcome.code === "job_cancelled" || outcome.code === "job_not_active"
                ? 409
                : outcome.code === "side_effects_failed"
                  ? 500
                  : 400;
          throw new HttpError(status, outcome.code);
        }
        return c.json({ job: outcome.job });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(500, "job_completion_failed");
      }
    }
  );

  app.post(
    "/:id/fail",
    requireScopes("manage:jobs"),
    requireServicePrincipal(),
    zValidator("json", failJobBodySchema, (result, c) => {
      if (!result.success) return c.json({ error: "invalid_job_error" }, 400);
    }),
    async (c) => {
      // A terminal failure's side effects run inside failJob (via the settlement
      // ledger, J64), so a 500 here — a store write failed — is retried by the
      // watcher and the retry settles it. Only an unknown id is a 404 (API31).
      const { error, attempt } = c.req.valid("json");
      return c.json({
        job: await notFoundAs404(() =>
          jobsService.failJob(ctx, c.req.param("id"), error, attempt === undefined ? {} : { attempt })
        )
      });
    }
  );

  app.post("/:id/cancel", requireScopes("manage:jobs"), requirePrivilege(ctx, "ops"), async (c) =>
    c.json({ job: await notFoundAs404(() => jobsService.cancelJob(ctx, c.req.param("id"))) })
  );

  app.post("/:id/retry", requireScopes("manage:jobs"), requirePrivilege(ctx, "ops"), async (c) => {
    try {
      return c.json({ job: await notFoundAs404(() => jobsService.retryJob(ctx, c.req.param("id"))) });
    } catch (error) {
      if (error instanceof Error && /only failed/i.test(error.message)) throw new HttpError(409, "job_not_failed");
      throw error;
    }
  });

  app.post("/:id/accept-failure", requireScopes("manage:jobs"), requirePrivilege(ctx, "ops"), async (c) => {
    try {
      return c.json({ job: await notFoundAs404(() => jobsService.acceptFailedJob(ctx, c.req.param("id"))) });
    } catch (error) {
      if (error instanceof Error && /only failed/i.test(error.message)) throw new HttpError(409, "job_not_failed");
      throw error;
    }
  });

  app.get("/:id", requireScopes("read:knowledge"), async (c) => {
    const job = await jobsService.getJob(ctx, c.req.param("id"));
    if (!job) throw new HttpError(404, "job_not_found");
    return c.json({ job });
  });

  return app;
}

// Maps exactly a missing job to 404 (API31). Every other error propagates to
// the app's error handler as a 500, so a watcher can tell "this job is gone"
// (stop) from "the API failed" (retry) — they used to be one 404.
async function notFoundAs404<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof JobNotFoundError) throw new HttpError(404, "job_not_found");
    throw error;
  }
}
