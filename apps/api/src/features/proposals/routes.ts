import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { apiLink, parseLimit } from "../../platform/paths.js";
import { HttpError } from "../../http/errors.js";
import * as proposalsService from "./service.js";
import { draftFromGapsBodySchema, proposalStatusBodySchema } from "./schema.js";

export function proposalRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/", requireScopes("read:knowledge"), async (c) => {
    const limit = parseLimit(c.req.query("limit") ?? null, 50);
    const statusFilter = c.req.query("status") ?? null;
    const options = proposalsService.isProposalStatus(statusFilter) ? { status: statusFilter } : undefined;
    return c.json({ proposals: await proposalsService.list(ctx, limit, options) });
  });

  // Shared by /from-gap and /from-gaps. Registering inline (rather than as a bare
  // handler reused across paths) lets zValidator's validated type flow into
  // c.req.valid("json").
  const registerCreateFromGaps = (path: string): void => {
    app.post(
      path,
      requireScopes("manage:knowledge"),
      zValidator("json", draftFromGapsBodySchema, (result, c) => {
        if (!result.success) {
          return c.json({ error: "gap_summary_required" }, 400);
        }
      }),
      async (c) => {
        const payload = c.req.valid("json");

        const requested = [...(payload.summaries ?? []), ...(payload.summary ? [payload.summary] : [])];
        const outcome = await proposalsService.draftFromGaps(ctx, requested, {
          targetPath: payload.targetPath,
          flowId: payload.flowId,
          sourceIds: payload.sourceIds,
          destinationId: payload.destinationId
        });

        if (!outcome.ok) {
          throw new HttpError(outcome.code === "gap_summary_required" ? 400 : 404, outcome.code);
        }

        return c.json(
          {
            job: outcome.job,
            links: {
              job: apiLink(`/jobs/${outcome.job.id}`),
              wait: apiLink(`/jobs/${outcome.job.id}/wait`),
              cancel: apiLink(`/jobs/${outcome.job.id}/cancel`),
              proposals: apiLink("/proposals")
            }
          },
          202
        );
      }
    );
  };

  registerCreateFromGaps("/from-gap");
  registerCreateFromGaps("/from-gaps");

  app.get("/:id", requireScopes("read:knowledge"), async (c) => {
    const proposal = await proposalsService.get(ctx, c.req.param("id"));
    if (!proposal) {
      throw new HttpError(404, "proposal_not_found");
    }
    return c.json({ proposal });
  });

  app.post(
    "/:id/status",
    requireScopes("manage:knowledge"),
    zValidator("json", proposalStatusBodySchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "valid_proposal_status_required" }, 400);
      }
    }),
    async (c) => {
      const { status } = c.req.valid("json");

      const proposal = await proposalsService.updateStatus(ctx, c.req.param("id"), status);
      if (!proposal) {
        throw new HttpError(404, "proposal_not_found");
      }

      if (proposal.status === "merged") {
        // The merge is recorded synchronously above. The cascade (resolving gaps
        // and re-indexing the destination, which fetches/fast-forwards a git
        // checkout) can be slow, so run it off the request thread and report that
        // it was scheduled rather than blocking the response on a network fetch.
        ctx.background.run(`merge-cascade ${proposal.id}`, async () => {
          await proposalsService.runMergeCascade(ctx, proposal);
        });
        return c.json({ proposal, cascadeScheduled: true });
      }

      return c.json({ proposal });
    }
  );

  app.post("/:id/publish", requireScopes("manage:knowledge"), async (c) => {
    const proposal = await proposalsService.get(ctx, c.req.param("id"));
    if (!proposal) {
      throw new HttpError(404, "proposal_not_found");
    }

    if (proposal.status !== "ready") {
      throw new HttpError(409, "proposal_not_ready", "Only ready proposals can be published.");
    }

    // Git execution happens in the Task 7 watcher runner; the API validates the
    // repository pre-flight then enqueues. Invalid publishes still fail fast with
    // the original 409 codes before any job is created.
    const outcome = await proposalsService.requestProposalPublication(ctx, proposal);
    if (!outcome.ok) {
      throw new HttpError(409, outcome.code, outcome.message);
    }

    return c.json(
      {
        job: outcome.job,
        links: {
          job: apiLink(`/jobs/${outcome.job.id}`),
          wait: apiLink(`/jobs/${outcome.job.id}/wait`),
          cancel: apiLink(`/jobs/${outcome.job.id}/cancel`),
          proposal: apiLink(`/proposals/${proposal.id}`)
        }
      },
      202
    );
  });

  // The non-generative execution context the Task 7 publication runner fetches
  // before executing git: the proposal plus the credential-free repository config.
  app.get("/:id/execution-context", requireScopes("manage:knowledge"), async (c) => {
    const outcome = await proposalsService.getProposalExecutionContext(ctx, c.req.param("id"));
    if (!outcome.ok) {
      const status = outcome.code === "proposal_not_found" ? 404 : 409;
      throw new HttpError(status, outcome.code, "message" in outcome ? outcome.message : undefined);
    }

    return c.json({ proposal: outcome.proposal, repository: outcome.repository });
  });

  return app;
}
