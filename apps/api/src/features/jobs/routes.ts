import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { HttpError } from "../../http/errors.js";
import { readJsonBody } from "../../http/body.js";
import * as jobsService from "./service.js";
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
    zValidator("json", createJobBodySchema, (result, c) => {
      if (!result.success) return c.json({ error: "invalid_job" }, 400);
    }),
    async (c) => {
      const { type, input } = c.req.valid("json");
      return c.json({ job: await jobsService.createJob(ctx, type, input) }, 202);
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

  app.post(
    "/claim",
    requireScopes("manage:jobs"),
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
      return c.json({ job: result.job }, result.terminal ? 200 : 202);
    } catch {
      throw new HttpError(404, "job_not_found");
    }
  });

  app.post("/:id/heartbeat", requireScopes("manage:jobs"), async (c) => {
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
    zValidator("json", completeJobBodySchema, (result, c) => {
      if (!result.success) return c.json({ error: "invalid_output" }, 400);
    }),
    async (c) => {
      const { output, executor } = c.req.valid("json");
      try {
        const outcome = await jobsService.completeJob(ctx, c.req.param("id"), output, executor);
        if (!outcome.ok) {
          const status = outcome.code === "job_not_found" ? 404 : outcome.code === "job_cancelled" ? 409 : 400;
          throw new HttpError(status, outcome.code);
        }
        // The job's output is durably persisted whenever ok is true, even if a
        // side effect (proposal creation, fold reconcile, ...) failed — see
        // completeJob's docstring. Report that failure on the response (200, not
        // 500: the watcher must not treat this as a reason to fall back to
        // fail()/retry, which would needlessly re-run the paid-for generation)
        // so operators can see it without it looking like a completion failure.
        return c.json(
          outcome.sideEffectsError ? { job: outcome.job, sideEffectsError: outcome.sideEffectsError } : { job: outcome.job }
        );
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(500, "job_completion_failed");
      }
    }
  );

  app.post(
    "/:id/fail",
    requireScopes("manage:jobs"),
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

  app.post("/:id/cancel", requireScopes("manage:jobs"), async (c) => {
    try {
      return c.json({ job: await jobsService.cancelJob(ctx, c.req.param("id")) });
    } catch {
      throw new HttpError(404, "job_not_found");
    }
  });

  app.post("/:id/retry", requireScopes("manage:jobs"), async (c) => {
    try {
      return c.json({ job: await jobsService.retryJob(ctx, c.req.param("id")) });
    } catch (error) {
      if (error instanceof Error && /only failed/i.test(error.message)) throw new HttpError(409, "job_not_failed");
      throw new HttpError(404, "job_not_found");
    }
  });

  app.post("/:id/accept-failure", requireScopes("manage:jobs"), async (c) => {
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
    return c.json({ job });
  });

  return app;
}
