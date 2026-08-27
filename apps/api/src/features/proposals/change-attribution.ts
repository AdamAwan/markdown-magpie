import type { Proposal } from "@magpie/core";
import type { JobType } from "@magpie/jobs";
import type { AppContext } from "../../context.js";
import type { KnowledgeChangeAttribution } from "../../stores/knowledge-change-store.js";
import { logger } from "../../logger.js";
import * as sourceSyncService from "../source-sync/service.js";

// The job types a maintenance patrol drafts through. A proposal drafted by one of
// these is a patrol's doing, whatever else it links to.
const PATROL_JOB_TYPES = new Set<JobType>([
  "verify_document",
  "correct_document",
  "improve_document",
  "dedupe_documents",
  "split_document"
]);

/**
 * Resolves why a merged proposal changed the knowledge base, for the change log.
 *
 * A DECORATION on an independently-correct diff, never a dependency of it: every
 * lookup here is allowed to come back empty, and the worst outcome is cause
 * "external" on an entry that still records a true change. Failures are logged
 * and swallowed for the same reason — an attribution lookup must never be able to
 * fail a merge cascade.
 *
 * Resolution order follows the design: the source-sync run join first (it is the
 * only cause that also carries an upstream commit range), then the proposal's own
 * gap/seed links, then the drafting job's type for the patrol lenses.
 */
export async function attributionForMergedProposal(
  ctx: AppContext,
  proposal: Proposal
): Promise<KnowledgeChangeAttribution> {
  const links = {
    proposalId: proposal.id,
    ...(proposal.jobId ? { jobId: proposal.jobId } : {}),
    summary: proposal.title
  };

  try {
    if (proposal.jobId) {
      const origin = await sourceSyncService.resolveSourceOrigin(ctx, proposal.jobId);
      if (origin) {
        return {
          ...links,
          cause: "source_sync",
          sourceId: origin.sourceId,
          ...(origin.fromSha ? { sourceFromSha: origin.fromSha } : {}),
          sourceToSha: origin.toSha
        };
      }
    }

    if (proposal.gapClusterId) {
      return { ...links, cause: "gap", summary: proposal.gapSummary ?? proposal.title };
    }

    if (proposal.seedPlanId) {
      return { ...links, cause: "seed" };
    }

    if (proposal.jobId) {
      const job = await ctx.jobs.get(proposal.jobId);
      if (job && PATROL_JOB_TYPES.has(job.type)) {
        return { ...links, cause: "patrol" };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    logger.warn({ proposalId: proposal.id, err: message }, "resolving knowledge change attribution failed");
  }

  // A merged proposal Magpie cannot attribute is still a merged proposal: the
  // entry keeps the proposal link and reads as an unattributed change.
  return { ...links, cause: "external" };
}
