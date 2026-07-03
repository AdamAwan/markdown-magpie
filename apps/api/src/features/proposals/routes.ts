import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppContext } from "../../context.js";
import { requireScopes } from "../../auth/middleware.js";
import { assertCan, can } from "../../auth/capabilities.js";
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
    // Flow-scoped read: a role-aware principal only sees proposals for the flows it
    // can read. Filters (rather than 403s) so a curator's list is naturally narrowed
    // to their own flows. Inactive when no grants are configured.
    const proposals = (await proposalsService.list(ctx, limit, options)).filter((proposal) =>
      can(ctx, c, "read", proposal.flowId)
    );
    return c.json({ proposals });
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

        // Drafting writes into a flow's knowledge base, so it needs `manage` on the
        // target flow. When the flow isn't named explicitly, only a wildcard manager
        // qualifies (a single-flow curator must name their flow to draft into it).
        assertCan(ctx, c, "manage", payload.flowId);

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
    // A proposal the caller can't read is reported as not-found rather than 403, so
    // proposal ids in other flows can't be enumerated across the flow boundary.
    if (!proposal || !can(ctx, c, "read", proposal.flowId)) {
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

      // Resolve the proposal's flow before mutating: hide cross-flow proposals as
      // not-found, then require `manage` on the flow to change its status (merge etc.).
      const id = c.req.param("id");
      const existing = await proposalsService.get(ctx, id);
      if (!existing || !can(ctx, c, "read", existing.flowId)) {
        throw new HttpError(404, "proposal_not_found");
      }
      assertCan(ctx, c, "manage", existing.flowId);

      // The pr-opened → merged transition is owned by the PR-poll path
      // (refresh_flow_snapshot + applyPullRequestTransition): it flips a proposal
      // to merged only once its real pull request has merged in git. A proposal
      // with a live pull request must not be hand-asserted merged here, or a user
      // could claim a merge that never happened. The manual action stays available
      // as the no-PR fallback — a branch pushed without a pull request to poll
      // (e.g. a deployment with no GITHUB_TOKEN, or a local-git destination),
      // which nothing auto-transitions. A pollable PR is exactly a recorded
      // pullRequestUrl (⇔ status pr-opened), so keying on it keeps the
      // GitHub-with-PR and no-PR cases cleanly separated.
      if (status === "merged" && existing.publication?.pullRequestUrl) {
        throw new HttpError(
          409,
          "proposal_merge_tracked_by_pull_request",
          "This proposal has an open pull request; it is marked merged automatically when that PR merges."
        );
      }

      const proposal = await proposalsService.updateStatus(ctx, id, status);
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
    if (!proposal || !can(ctx, c, "read", proposal.flowId)) {
      throw new HttpError(404, "proposal_not_found");
    }
    assertCan(ctx, c, "manage", proposal.flowId);

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
    const id = c.req.param("id");
    // The watcher's publication runner fetches this over an M2M token (no roles
    // claim), so the service-principal carve-out lets it through; a role-aware human
    // still needs `manage` on the proposal's flow.
    const proposal = await proposalsService.get(ctx, id);
    if (!proposal || !can(ctx, c, "read", proposal.flowId)) {
      throw new HttpError(404, "proposal_not_found");
    }
    assertCan(ctx, c, "manage", proposal.flowId);

    const outcome = await proposalsService.getProposalExecutionContext(ctx, id);
    if (!outcome.ok) {
      const status = outcome.code === "proposal_not_found" ? 404 : 409;
      throw new HttpError(status, outcome.code, "message" in outcome ? outcome.message : undefined);
    }

    return c.json({ proposal: outcome.proposal, repository: outcome.repository });
  });

  return app;
}
