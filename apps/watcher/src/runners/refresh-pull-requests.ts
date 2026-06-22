import type { JobCapability, JobType, JobView } from "@magpie/jobs";
import { refreshPullRequestsOutputSchema } from "@magpie/jobs";
import { fetchPullRequestStatus as defaultFetchPullRequestStatus } from "@magpie/git";
import type { WatcherApi } from "../http-client.js";

// The single GitHub lookup the runner needs, injected so tests stay offline.
export type FetchPullRequestStatus = typeof defaultFetchPullRequestStatus;

// Polls the open pull requests raised from proposals and reports each one's
// merged/closed state back to the API, which applies the proposal-status
// transitions. Registered only under the github capability: the watcher holds the
// GitHub token the API no longer does, so PR polling lives here rather than in the
// API's reconciler.
export class RefreshPullRequestsRunner {
  readonly capability: JobCapability = "github";

  constructor(
    private readonly api: WatcherApi,
    private readonly fetchPullRequestStatus: FetchPullRequestStatus = defaultFetchPullRequestStatus
  ) {}

  supports(type: JobType): boolean {
    return type === "refresh_pull_requests";
  }

  async run(_job: JobView, signal: AbortSignal): Promise<unknown> {
    const open = await this.api.listOpenPullRequests(signal);
    console.log(`refresh_pull_requests: checking ${open.length} open pull request(s)`);
    const results: Array<{ proposalId: string; state: "open" | "closed"; merged: boolean }> = [];
    for (const pr of open) {
      // Honour cancellation/shutdown between host calls so a long list aborts promptly.
      signal.throwIfAborted();
      let status: { merged: boolean; state: "open" | "closed" } | undefined;
      try {
        status = await this.fetchPullRequestStatus(pr.pullRequestUrl);
      } catch (error) {
        const message = error instanceof Error ? error.message : "pull request lookup failed";
        console.warn(`refresh_pull_requests: PR status check failed for proposal ${pr.proposalId}: ${message}`);
        continue;
      }
      if (!status) {
        // Not a resolvable PR / no token / gone: leave the proposal untouched this run.
        continue;
      }
      results.push({ proposalId: pr.proposalId, state: status.state, merged: status.merged });
    }
    console.log(`refresh_pull_requests: resolved ${results.length}/${open.length} pull request(s)`);
    return refreshPullRequestsOutputSchema.parse({ results });
  }
}
