import { Hono } from "hono";
import type { Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { apiLink, parseLimit } from "../../platform/paths.js";
import { HttpError } from "../../http/errors.js";
import { parseJsonBody } from "../../http/body.js";
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

  const createFromGaps = async (c: Context): Promise<Response> => {
    const payload = await parseJsonBody(c, draftFromGapsBodySchema, "gap_summary_required");

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

    if (outcome.mode === "direct") {
      return c.json({ proposal: outcome.proposal }, 201);
    }

    return c.json(
      {
        job: outcome.job,
        links: {
          status: apiLink(`/ai-jobs/${outcome.job.id}`),
          proposals: apiLink("/proposals")
        }
      },
      202
    );
  };

  app.post("/from-gap", requireScopes("manage:knowledge"), createFromGaps);
  app.post("/from-gaps", requireScopes("manage:knowledge"), createFromGaps);

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

    const outcome = await proposalsService.publishReadyProposal(ctx, proposal);
    if (!outcome.ok) {
      throw new HttpError(409, outcome.code, outcome.message);
    }

    return c.json({
      proposal: outcome.proposal,
      publication: outcome.publication,
      pullRequestUrl: outcome.pullRequestUrl,
      pullRequestWarning: outcome.pullRequestWarning
    });
  });

  return app;
}
