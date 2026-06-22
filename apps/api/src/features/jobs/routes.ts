import { Hono } from "hono";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { HttpError } from "../../http/errors.js";
import { readJsonBody } from "../../http/body.js";
import * as jobsService from "./service.js";
import {
  claimJobBodySchema, completeJobBodySchema, createJobBodySchema, failJobBodySchema,
  heartbeatJobBodySchema, listJobsQuerySchema
} from "./schema.js";

export function jobRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.post("/", requireScopes("manage:jobs"), async (c) => {
    const parsed = createJobBodySchema.safeParse(await readJsonBody(c));
    if (!parsed.success) throw new HttpError(400, "invalid_job");
    return c.json({ job: await jobsService.createJob(ctx, parsed.data.type, parsed.data.input) }, 202);
  });

  app.get("/", requireScopes("read:knowledge"), async (c) => {
    const parsed = listJobsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new HttpError(400, "invalid_job_filters");
    return c.json(await jobsService.listJobs(ctx, parsed.data));
  });

  app.get("/schedules", requireScopes("read:knowledge"), async (c) =>
    c.json({ schedules: await ctx.jobs.listSchedules() }));

  app.post("/claim", requireScopes("manage:jobs"), async (c) => {
    const parsed = claimJobBodySchema.safeParse(await readJsonBody(c));
    if (!parsed.success) throw new HttpError(400, "worker_capabilities_required");
    const job = await jobsService.claimJob(ctx, parsed.data.workerName, parsed.data.capabilities);
    return c.json({ job: job ?? null });
  });

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

  app.post("/:id/complete", requireScopes("manage:jobs"), async (c) => {
    const parsed = completeJobBodySchema.safeParse(await readJsonBody(c));
    if (!parsed.success) throw new HttpError(400, "invalid_output");
    try {
      const outcome = await jobsService.completeJob(ctx, c.req.param("id"), parsed.data.output, parsed.data.executor);
      if (!outcome.ok) {
        const status = outcome.code === "job_not_found" ? 404 : outcome.code === "job_cancelled" ? 409 : 400;
        throw new HttpError(status, outcome.code);
      }
      return c.json({ job: outcome.job });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(500, "job_completion_failed");
    }
  });

  app.post("/:id/fail", requireScopes("manage:jobs"), async (c) => {
    const parsed = failJobBodySchema.safeParse(await readJsonBody(c));
    if (!parsed.success) throw new HttpError(400, "invalid_job_error");
    try { return c.json({ job: await jobsService.failJob(ctx, c.req.param("id"), parsed.data.error) }); }
    catch { throw new HttpError(404, "job_not_found"); }
  });

  app.post("/:id/cancel", requireScopes("manage:jobs"), async (c) => {
    try { return c.json({ job: await jobsService.cancelJob(ctx, c.req.param("id")) }); }
    catch { throw new HttpError(404, "job_not_found"); }
  });

  app.post("/:id/retry", requireScopes("manage:jobs"), async (c) => {
    try { return c.json({ job: await jobsService.retryJob(ctx, c.req.param("id")) }); }
    catch (error) {
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
