import { Hono } from "hono";
import type { Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppContext } from "../../context.js";
import { apiLink, parseLimit } from "../../platform/paths.js";
import { HttpError } from "../../http/errors.js";
import { readJsonBody } from "../../http/body.js";
import * as proposalsService from "./service.js";
import { proposalStatusBodySchema } from "./schema.js";

export function proposalRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const limit = parseLimit(c.req.query("limit") ?? null, 50);
    const statusFilter = c.req.query("status") ?? null;
    const options = proposalsService.isProposalStatus(statusFilter) ? { status: statusFilter } : undefined;
    return c.json({ proposals: await proposalsService.list(ctx, limit, options) });
  });

  const createFromGaps = async (c: Context): Promise<Response> => {
    const payload = await readJsonBody<{
      summary?: string;
      summaries?: string[];
      targetPath?: string;
      flowId?: string;
      sourceIds?: string[];
      destinationId?: string;
    }>(c);

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

  app.post("/from-gap", createFromGaps);
  app.post("/from-gaps", createFromGaps);

  app.get("/:id", async (c) => {
    const proposal = await proposalsService.get(ctx, c.req.param("id"));
    if (!proposal) {
      throw new HttpError(404, "proposal_not_found");
    }
    return c.json({ proposal });
  });

  app.post(
    "/:id/status",
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
        const { resolvedGapCount, reindexed } = await proposalsService.runMergeCascade(ctx, proposal);
        return c.json({ proposal, resolvedGapCount, reindexed });
      }

      return c.json({ proposal });
    }
  );

  app.post("/:id/publish", async (c) => {
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
