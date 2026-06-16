import type { ScheduledTaskSettings } from "@magpie/core";
import { fetchPullRequestStatus } from "@magpie/git";
import { selectClustersToDraft } from "../stores/gap-clustering.js";
import type { AppContext } from "../context.js";
import * as gapsService from "../features/gaps/service.js";
import * as proposalsService from "../features/proposals/service.js";

// A background side-process the operator can schedule from the Crunch page. The
// registry is the single place to add new scheduled work: give it a key, copy,
// a default cron, and a handler, and it appears in the UI and the scheduler.
export interface ScheduledTaskDefinition {
  key: string;
  label: string;
  description: string;
  defaultCron: string;
  run(ctx: AppContext): Promise<void>;
}

export const scheduledTaskDefinitions: ScheduledTaskDefinition[] = [
  {
    key: "pull-request-refresh",
    label: "Pull request status refresh",
    description:
      "Checks open pull requests and advances proposals when they are merged (resolve gaps + re-index) " +
      "or closed (mark rejected) on the host. Requires GITHUB_TOKEN.",
    defaultCron: "*/10 * * * *",
    run: refreshPullRequests
  },
  {
    key: "gaps-to-pull-requests",
    label: "Clustered gaps → pull requests",
    description:
      "Clusters the open knowledge gaps, drafts a proposal for any cluster not already covered, then " +
      "publishes every draft and ready proposal as a pull request (auto-promoting drafts to ready). " +
      "A fully automated pipeline with no manual review step.",
    defaultCron: "0 * * * *",
    run: processGapsIntoPullRequests
  }
];

export function findScheduledTask(key: string): ScheduledTaskDefinition | undefined {
  return scheduledTaskDefinitions.find((task) => task.key === key);
}

// The default (unsaved) schedule for a registered task, so the UI can render a
// control before the schedule has ever been saved.
export function defaultScheduledTaskSettings(task: ScheduledTaskDefinition): ScheduledTaskSettings {
  return { key: task.key, enabled: false, cron: task.defaultCron };
}

// Always returns one row per registered task, merging in any saved schedule so
// the UI can render a control even before the schedule has been saved once.
export async function scheduledTasksForResponse(ctx: AppContext): Promise<
  Array<{ key: string; label: string; description: string; settings: ScheduledTaskSettings }>
> {
  const stored = await ctx.stores.scheduledTasks.listSettings();
  const byKey = new Map(stored.map((setting) => [setting.key, setting]));
  return scheduledTaskDefinitions.map((task) => ({
    key: task.key,
    label: task.label,
    description: task.description,
    settings: byKey.get(task.key) ?? defaultScheduledTaskSettings(task)
  }));
}

// For every proposal still awaiting its PR, ask the host whether it merged or
// closed and advance the proposal accordingly. No-ops gracefully when no
// GITHUB_TOKEN is configured (fetchPullRequestStatus returns undefined).
async function refreshPullRequests(ctx: AppContext): Promise<void> {
  const open = await ctx.stores.proposals.list(200, { status: "pr-opened" });
  for (const proposal of open) {
    const pullRequestUrl = proposal.publication?.pullRequestUrl;
    if (!pullRequestUrl) {
      continue;
    }

    let status: Awaited<ReturnType<typeof fetchPullRequestStatus>>;
    try {
      status = await fetchPullRequestStatus(pullRequestUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : "pull request lookup failed";
      console.warn(`Pull request status check failed for proposal ${proposal.id}: ${message}`);
      continue;
    }
    if (!status) {
      continue;
    }

    if (status.merged) {
      const merged = await ctx.stores.proposals.updateStatus(proposal.id, "merged");
      if (merged) {
        console.log(`Detected merged pull request for proposal ${proposal.id}; running merge cascade.`);
        await proposalsService.runMergeCascade(ctx, merged);
      }
    } else if (status.state === "closed") {
      // Closed without merging is effectively a rejection of the published
      // proposal; mark it so the task stops chasing a dead PR.
      await ctx.stores.proposals.updateStatus(proposal.id, "rejected");
      console.log(`Pull request for proposal ${proposal.id} was closed without merging; marked rejected.`);
    }
  }
}

// The set of gap summaries that already have a proposal, so the gap-to-PR task
// never drafts the same gap twice. This deliberately includes rejected proposals
// (a closed PR): without it, an autonomous run would re-draft and re-raise every
// hour the very content a human just declined. Merged proposals resolve their
// gaps at the source, so those summaries stop appearing as candidates and need
// no entry here; proposals.list already omits merged rows.
export async function coveredGapSummaries(ctx: AppContext): Promise<Set<string>> {
  const summaries = new Set<string>();
  for (const proposal of await ctx.stores.proposals.list(500)) {
    for (const summary of proposalsService.splitGapSummaries(proposal.gapSummary)) {
      summaries.add(summary);
    }
  }
  return summaries;
}

// End-to-end gap-to-PR pipeline. First drafts proposals for any gap cluster not
// already covered, then auto-promotes every draft to ready and publishes all
// draft/ready proposals as pull requests. Each step is best-effort and logged so
// one failure can't abort the whole run.
async function processGapsIntoPullRequests(ctx: AppContext): Promise<void> {
  // 1) Cluster the open gaps and draft a proposal for each uncovered cluster.
  const candidates = await ctx.stores.questionLogs.listGapCandidates(200);
  if (candidates.length > 0) {
    const clusters = await gapsService.clusterGapCandidates(ctx, candidates);
    const toDraft = selectClustersToDraft(
      clusters,
      candidates.map((candidate) => candidate.summary),
      await coveredGapSummaries(ctx)
    );
    for (const summaries of toDraft) {
      try {
        const outcome = await proposalsService.draftFromGaps(ctx, summaries);
        if (!outcome.ok) {
          console.warn(`Gap-to-PR task skipped a cluster: ${outcome.code}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "draft failed";
        console.warn(`Gap-to-PR task failed to draft a cluster: ${message}`);
      }
    }
  }

  // 2) Get every unpublished proposal to a PR. Drafts are auto-promoted to ready
  // first; "branch-pushed" proposals are ones whose branch landed but whose PR
  // never opened (transient host error, or no token at the time), so we retry the
  // PR for them too. Raising a PR for a branch that already has one is rejected
  // by the host, so this can't create duplicates.
  const pending = [
    ...(await ctx.stores.proposals.list(200, { status: "draft" })),
    ...(await ctx.stores.proposals.list(200, { status: "ready" })),
    ...(await ctx.stores.proposals.list(200, { status: "branch-pushed" }))
  ];
  for (const proposal of pending) {
    let candidate = proposal;
    if (candidate.status === "draft") {
      const promoted = await ctx.stores.proposals.updateStatus(candidate.id, "ready");
      if (!promoted) {
        continue;
      }
      candidate = promoted;
    }

    try {
      const outcome = await proposalsService.publishReadyProposal(ctx, candidate);
      if (outcome.ok) {
        console.log(
          outcome.pullRequestUrl
            ? `Gap-to-PR task raised ${outcome.pullRequestUrl} for proposal ${candidate.id}.`
            : `Gap-to-PR task pushed a branch for proposal ${candidate.id} (no PR raised).`
        );
      } else {
        console.warn(`Gap-to-PR task could not publish proposal ${candidate.id}: ${outcome.code} (${outcome.message}).`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "publish failed";
      console.warn(`Gap-to-PR task failed to publish proposal ${candidate.id}: ${message}`);
    }
  }
}
