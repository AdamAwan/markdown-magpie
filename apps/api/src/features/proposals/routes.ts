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

      // updateStatus is an unconditional write (it doesn't no-op on a repeated
      // status), so the cascade must be gated on the TRANSITION into merged, not
      // on the resulting status: compare against the status read above. Without
      // this, a retried or double-clicked "mark merged" POST (the request already
      // succeeded once, resulting proposal.status is still "merged") would
      // re-enqueue verify_gap_closure, running its re-asks a second time and
      // double-counting any still-open verdict against CLOSURE_RETRY_CAP. See
      // mergeLocalProposal, which is retry-safe the same way (guards on the prior
      // status before writing).
      const wasAlreadyMerged = existing.status === "merged";
      const proposal = await proposalsService.updateStatus(ctx, id, status);
      if (!proposal) {
        throw new HttpError(404, "proposal_not_found");
      }

      if (proposal.status === "merged" && !wasAlreadyMerged) {
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

  app.post("/:id/merge", requireScopes("manage:knowledge"), async (c) => {
    const id = c.req.param("id");
    const existing = await proposalsService.get(ctx, id);
    if (!existing || !can(ctx, c, "read", existing.flowId)) {
      throw new HttpError(404, "proposal_not_found");
    }
    assertCan(ctx, c, "manage", existing.flowId);

    const outcome = await proposalsService.mergeLocalProposal(ctx, existing);
    if (!outcome.ok) {
      // All three failures are client/state errors (bad status, wrong destination
      // type, or an unresolvable merge) — 409 Conflict with the specific code.
      throw new HttpError(409, outcome.code, outcome.message);
    }

    // Merge is recorded synchronously; the slow cascade (resolve gaps + re-index,
    // which fetches/fast-forwards the checkout) runs off the request thread,
    // mirroring the /:id/status merged path.
    const proposal = outcome.proposal;
    ctx.background.run(`merge-cascade ${proposal.id}`, async () => {
      await proposalsService.runMergeCascade(ctx, proposal);
    });
    return c.json({ proposal, cascadeScheduled: true });
  });

  // Bin (reject) a branch-pushed local-git proposal: mark rejected, freeze its
  // cluster, and delete the review branch. The local mirror of closing a PR without
  // merging — there is no cascade (nothing merged), so this returns synchronously.
  app.post("/:id/reject", requireScopes("manage:knowledge"), async (c) => {
    const id = c.req.param("id");
    const existing = await proposalsService.get(ctx, id);
    if (!existing || !can(ctx, c, "read", existing.flowId)) {
      throw new HttpError(404, "proposal_not_found");
    }
    assertCan(ctx, c, "manage", existing.flowId);

    const outcome = await proposalsService.rejectLocalProposal(ctx, existing);
    if (!outcome.ok) {
      // Client/state errors (wrong status or non-local destination) — 409 Conflict
      // with the specific code, symmetric with the merge route.
      throw new HttpError(409, outcome.code, outcome.message);
    }

    return c.json({ proposal: outcome.proposal });
  });

  // Maintenance callback: the watcher claims a verify_gap_closure job and POSTs
  // here (mirroring the reconcile/patrol endpoints). The API holds the
  // orchestration — re-asking the triggering questions and running the
  // deterministic closure test — because it needs DB access; the only generative
  // step is the enqueued answer_question re-asks.
  app.post("/:id/verify-closure", requireScopes("manage:jobs"), async (c) => {
    const proposal = await proposalsService.get(ctx, c.req.param("id"));
    if (!proposal) {
      throw new HttpError(404, "proposal_not_found");
    }
    try {
      // Thread the request's abort signal so that if THIS POST times out on the
      // watcher (maintenanceTimeoutMs) and pg-boss retries the job, the aborted
      // original run unwinds instead of overlapping its own retry and writing a
      // duplicate set of gap_closure_verification rows (#195).
      const result = await proposalsService.verifyGapClosure(ctx, proposal, c.req.raw.signal);
      return c.json(result);
    } catch (error) {
      // A re-ask that never completed is an infrastructure failure (no provider
      // watcher was free — the single-watcher self-starve of #150), NOT a content
      // verdict. Return 503 so the watcher's verify_gap_closure job retries and its
      // own retry budget absorbs the outage, instead of the API recording a false
      // still_open that would wrongly reopen or park a correctly-merged doc.
      if (error instanceof proposalsService.VerificationIncompleteError) {
        throw new HttpError(503, "gap_closure_verification_incomplete", error.message);
      }
      // The request was aborted mid-run (the watcher already gave up and pg-boss
      // will retry). The client is gone, so the response is moot, but map it to a
      // 503 for the same "retry, don't treat as a verdict" semantics rather than
      // surfacing an unhandled 500.
      if (error instanceof proposalsService.VerificationAbortedError) {
        throw new HttpError(503, "gap_closure_verification_aborted", error.message);
      }
      throw error;
    }
  });

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
