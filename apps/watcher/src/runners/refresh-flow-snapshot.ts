import type { JobCapability, JobType, JobView } from "@magpie/jobs";
import { refreshFlowSnapshotOutputSchema } from "@magpie/jobs";
import {
  fetchPullRequestStatus as defaultFetchPullRequestStatus,
  fetchPullRequestReviewDecision as defaultFetchPullRequestReviewDecision
} from "@magpie/git";
import type { ReviewDecision } from "@magpie/core";
import type { WatcherApi } from "../http-client.js";

// The two GitHub lookups the runner needs, injected so tests stay offline.
export type FetchPullRequestStatus = typeof defaultFetchPullRequestStatus;
export type FetchPullRequestReviewDecision = typeof defaultFetchPullRequestReviewDecision;

// Polls the open pull requests raised from proposals and reports each one's
// merged/closed state — and, for still-open PRs, its review decision — back to the
// API, which applies the proposal-status transitions and persists the review
// decision. Registered only under the github capability: the watcher holds the
// GitHub token the API no longer does, so PR polling lives here rather than in the
// API's reconciler.
export class RefreshFlowSnapshotRunner {
  readonly capability: JobCapability = "github";

  constructor(
    private readonly api: WatcherApi,
    private readonly fetchPullRequestStatus: FetchPullRequestStatus = defaultFetchPullRequestStatus,
    private readonly fetchPullRequestReviewDecision: FetchPullRequestReviewDecision = defaultFetchPullRequestReviewDecision
  ) {}

  supports(type: JobType): boolean {
    return type === "refresh_flow_snapshot";
  }

  async run(_job: JobView, signal: AbortSignal): Promise<unknown> {
    const open = await this.api.listOpenPullRequests(signal);
    console.log(`refresh_flow_snapshot: checking ${open.length} open pull request(s)`);
    const results: Array<{ proposalId: string; state: "open" | "closed"; merged: boolean; reviewDecision?: ReviewDecision }> = [];
    for (const pr of open) {
      // Honour cancellation/shutdown between host calls so a long list aborts promptly.
      signal.throwIfAborted();
      let status: { merged: boolean; state: "open" | "closed" } | undefined;
      try {
        status = await this.fetchPullRequestStatus(pr.pullRequestUrl);
      } catch (error) {
        const message = error instanceof Error ? error.message : "pull request lookup failed";
        console.warn(`refresh_flow_snapshot: PR status check failed for proposal ${pr.proposalId}: ${message}`);
        continue;
      }
      if (!status) {
        // Not a resolvable PR / no token / gone: leave the proposal untouched this run.
        continue;
      }
      // Only a still-open, un-merged PR can be locked by an approval; a merged/closing
      // PR is transitioning to merged/rejected this run, so skip the extra lookup.
      let reviewDecision: ReviewDecision | undefined;
      if (status.state === "open" && !status.merged) {
        try {
          reviewDecision = await this.fetchPullRequestReviewDecision(pr.pullRequestUrl);
        } catch (error) {
          const message = error instanceof Error ? error.message : "review decision lookup failed";
          console.warn(`refresh_flow_snapshot: review decision check failed for proposal ${pr.proposalId}: ${message}`);
        }
      }
      results.push({
        proposalId: pr.proposalId,
        state: status.state,
        merged: status.merged,
        ...(reviewDecision ? { reviewDecision } : {})
      });
    }
    console.log(`refresh_flow_snapshot: resolved ${results.length}/${open.length} pull request(s)`);
    return refreshFlowSnapshotOutputSchema.parse({ results });
  }
}
