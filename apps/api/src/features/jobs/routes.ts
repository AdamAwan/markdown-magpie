import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppContext } from "../../context.js";
import { requireScopes, requireServicePrincipal } from "../../auth/middleware.js";
import { requirePrivilege } from "../../auth/capabilities.js";
import { HttpError } from "../../http/errors.js";
import { readJsonBody } from "../../http/body.js";
import * as jobsService from "./service.js";
import { visibleJob } from "./visibility.js";
import {
  claimJobBodySchema,
  completeJobBodySchema,
  createJobBodySchema,
  failJobBodySchema,
  heartbeatJobBodySchema,
  listJobsQuerySchema
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
    const result = await jobsService.listJobs(ctx, parsed.data);
    // Content of jobs in flows the caller cannot see is redacted (AZ34).
    return c.json({ ...result, jobs: result.jobs.map((job) => visibleJob(ctx, c, job)) });
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
    try {
      const result = await jobsService.waitForJob(ctx, c.req.param("id"));
      return c.json({ job: visibleJob(ctx, c, result.job) }, result.terminal ? 200 : 202);
    } catch {
      throw new HttpError(404, "job_not_found");
    }
  });

  app.post("/:id/heartbeat", requireScopes("manage:jobs"), requireServicePrincipal(), async (c) => {
    try {
      const parsed = heartbeatJobBodySchema.safeParse(await readJsonBody(c));
      const workerName = parsed.success ? parsed.data.workerName : undefined;
      const job = await jobsService.heartbeatJob(ctx, c.req.param("id"), workerName);
      return c.json({ job, cancelled: job.state === "cancelled" });
    } catch (error) {
      if (error instanceof HttpError) throw error;
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
      const { output, executor, usage, provider, model } = c.req.valid("json");
      try {
        const outcome = await jobsService.completeJob(ctx, c.req.param("id"), output, executor, usage, {
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {})
        });
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
          const status =
            outcome.code === "job_not_found"
              ? 404
              : outcome.code === "job_cancelled"
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
      const { error } = c.req.valid("json");
      try {
        return c.json({ job: await jobsService.failJob(ctx, c.req.param("id"), error) });
      } catch {
        throw new HttpError(404, "job_not_found");
      }
    }
  );

  app.post("/:id/cancel", requireScopes("manage:jobs"), requirePrivilege(ctx, "ops"), async (c) => {
    try {
      return c.json({ job: await jobsService.cancelJob(ctx, c.req.param("id")) });
    } catch {
      throw new HttpError(404, "job_not_found");
    }
  });

  app.post("/:id/retry", requireScopes("manage:jobs"), requirePrivilege(ctx, "ops"), async (c) => {
    try {
      return c.json({ job: await jobsService.retryJob(ctx, c.req.param("id")) });
    } catch (error) {
      if (error instanceof Error && /only failed/i.test(error.message)) throw new HttpError(409, "job_not_failed");
      throw new HttpError(404, "job_not_found");
    }
  });

  app.post("/:id/accept-failure", requireScopes("manage:jobs"), requirePrivilege(ctx, "ops"), async (c) => {
    try {
      return c.json({ job: await jobsService.acceptFailedJob(ctx, c.req.param("id")) });
    } catch (error) {
      if (error instanceof Error && /only failed/i.test(error.message)) throw new HttpError(409, "job_not_failed");
      throw new HttpError(404, "job_not_found");
    }
  });

  app.get("/:id", requireScopes("read:knowledge"), async (c) => {
    const job = await jobsService.getJob(ctx, c.req.param("id"));
    if (!job) throw new HttpError(404, "job_not_found");
    return c.json({ job: visibleJob(ctx, c, job) });
  });

  return app;
}
