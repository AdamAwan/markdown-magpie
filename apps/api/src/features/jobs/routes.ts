import { Hono } from "hono";
import type { AppContext } from "../../context.js";
import { HttpError } from "../../http/errors.js";
import { readJsonBody } from "../../http/body.js";
import * as jobsService from "./service.js";

export function jobRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const payload = await readJsonBody<{ type?: unknown; input?: unknown }>(c);

    if (!jobsService.isAiJobType(payload.type)) {
      throw new HttpError(400, "valid_job_type_required");
    }

    const job = await jobsService.createJob(ctx, payload.type, payload.input);
    return c.json({ job }, 201);
  });

  app.get("/", async (c) => c.json({ jobs: await jobsService.listJobs(ctx) }));

  app.post("/claim", async (c) => {
    const payload = await readJsonBody<{ workerName?: string; acceptedTypes?: unknown[] }>(c);
    const workerName = payload.workerName?.trim();

    if (!workerName) {
      throw new HttpError(400, "worker_name_required");
    }

    const acceptedTypes = (payload.acceptedTypes ?? []).filter(jobsService.isAiJobType);
    if (acceptedTypes.length === 0) {
      throw new HttpError(400, "accepted_types_required");
    }

    const job = await jobsService.claimJob(ctx, workerName, acceptedTypes);
    return c.json({ job: job ?? null });
  });

  app.post("/:id/complete", async (c) => {
    const payload = await readJsonBody<{ output?: unknown }>(c);

    try {
      const outcome = await jobsService.completeJob(ctx, c.req.param("id"), payload.output);
      if (!outcome.ok) {
        throw new HttpError(404, outcome.code);
      }
      return c.json({ job: outcome.job });
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Unexpected completion failure";
      throw new HttpError(500, "job_completion_failed", message);
    }
  });

  app.post("/:id/fail", async (c) => {
    const payload = await readJsonBody<{ error?: string }>(c);

    try {
      const job = await jobsService.failJob(ctx, c.req.param("id"), payload.error);
      return c.json({ job });
    } catch {
      throw new HttpError(404, "job_not_found");
    }
  });

  app.get("/:id", async (c) => {
    const job = await jobsService.getJob(ctx, c.req.param("id"));
    if (!job) {
      throw new HttpError(404, "job_not_found");
    }
    return c.json({ job });
  });

  return app;
}
