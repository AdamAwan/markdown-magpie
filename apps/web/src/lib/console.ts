import { ConsoleNotice, ConsoleSection, Health, JobTransitionMessage, JobType, JobView, KnowledgeStats, Proposal, UiMessage, WatcherView } from "./types";

export function sectionTitle(section: ConsoleSection): string {
  if (section === "knowledge") {
    return "Manage knowledge flows";
  }
  if (section === "gaps") {
    return "Turn weak answers into proposals";
  }
  if (section === "seed") {
    return "Plan and seed a flow from its sources";
  }
  if (section === "jobs") {
    return "Watch AI and MCP job flow";
  }
  if (section === "activity") {
    return "Audit background activity";
  }
  if (section === "insights") {
    return "See how the pipeline is performing";
  }
  if (section === "proposals") {
    return "Review generated Markdown proposals";
  }
  if (section === "schedules") {
    return "Manage scheduled background tasks";
  }
  if (section === "prompts") {
    return "Browse AI prompts";
  }
  if (section === "dataflow") {
    return "System data flow and architecture";
  }
  if (section === "config") {
    return "Inspect runtime configuration";
  }
  if (section === "mcp") {
    return "Connect your AI tools over MCP";
  }

  return "Ask and inspect cited answers";
}

export function sectionSubtitle(section: ConsoleSection): string {
  if (section === "knowledge") {
    return "Review each configured source-to-destination flow and index it into the knowledge base.";
  }
  if (section === "gaps") {
    return "Prioritise repeated gaps and draft Markdown updates from them.";
  }
  if (section === "seed") {
    return "Propose a source-grounded seed plan, review and edit it (charter, documents), then approve to draft straight into review — bypassing the demand-driven gap pipeline.";
  }
  if (section === "jobs") {
    return "See queued, claimed, completed, and failed AI work in one stable table.";
  }
  if (section === "activity") {
    return "Review the durable maintenance-run audit for scheduled and manual background work.";
  }
  if (section === "insights") {
    return "Track the knowledge-maintenance pipeline over the last 30 days: gap backlog, throughput, and conversion.";
  }
  if (section === "proposals") {
    return "Select a proposal and review its target path, rationale, and Markdown.";
  }
  if (section === "schedules") {
    return "Enable, disable, and run the per-flow background tasks: gap reconciliation, source-change sync, and the fix/improve patrols.";
  }
  if (section === "prompts") {
    return "Read the exact instruction text sent to the AI for each job type, and where each prompt is used.";
  }
  if (section === "dataflow") {
    return "Understand how Markdown, embeddings, questions, and proposals flow through the system.";
  }
  if (section === "config") {
    return "Check the active AI provider, stores, providers, repository paths, and whether secrets are set.";
  }
  if (section === "mcp") {
    return "Add the Markdown Magpie MCP server to Claude Code, Claude Desktop, VS Code, Cursor, or Continue and query the knowledge base from your editor.";
  }

  return "Ask and inspect cited answers";
}

export function buildAttentionNotices({
  health,
  jobs,
  openSection,
  stats,
  workers,
  uncoveredJobTypes
}: {
  health?: Health;
  jobs: JobView[];
  openSection: (section: ConsoleSection) => void;
  stats: KnowledgeStats;
  workers: WatcherView[];
  uncoveredJobTypes: JobType[];
}): ConsoleNotice[] {
  const notices: ConsoleNotice[] = [];
  const pendingJobs = jobs.filter(isActiveJob);
  const failedJobs = jobs.filter((job) => job.state === "failed" && !job.acceptedAt);

  if (health && !health.ok) {
    notices.push({
      id: "api-offline",
      title: "API is offline",
      body: "The console cannot index documents, answer questions, or process jobs until the API is reachable.",
      tone: "danger"
    });
  }

  if (stats.sectionCount === 0) {
    notices.push({
      id: "empty-knowledge",
      title: "No knowledge is indexed",
      body: "Direct answers will have no source material, and queued answer jobs will be created without useful context.",
      tone: "warning",
      actionLabel: "Open Knowledge",
      action: () => openSection("knowledge")
    });
  }

  if (pendingJobs.length > 0) {
    notices.push({
      id: "queue-waiting",
      title: `${pendingJobs.length} queued job${pendingJobs.length === 1 ? "" : "s"} waiting`,
      body: "Queued work runs on the watcher process. If these jobs stay queued after a refresh, make sure a capability-matched watcher is running.",
      tone: "warning",
      actionLabel: "Open Jobs",
      action: () => openSection("jobs")
    });
  }

  if (failedJobs.length > 0) {
    notices.push({
      id: "failed-jobs",
      title: `${failedJobs.length} AI job${failedJobs.length === 1 ? "" : "s"} failed`,
      body: "Open the job list to inspect provider or watcher errors before retrying the workflow.",
      tone: "danger",
      actionLabel: "Open Jobs",
      action: () => openSection("jobs")
    });
  }

  // Whether the running watcher fleet can execute every kind of job. With no
  // watchers, everything is uncovered — say that concisely rather than listing
  // every type. With some watchers but a capability gap, name exactly the job
  // types that will otherwise sit queued forever.
  if (workers.length === 0) {
    notices.push({
      id: "no-watchers",
      title: "No watchers are connected",
      body: "Background jobs run on watcher processes, and none are connected. Start a watcher to answer questions, draft proposals, and publish.",
      tone: "warning",
      actionLabel: "Open Jobs",
      action: () => openSection("jobs")
    });
  } else if (uncoveredJobTypes.length > 0) {
    const labels = uncoveredJobTypes.map(formatJobType).join(", ");
    notices.push({
      id: "uncovered-job-types",
      title: "No watcher can run these jobs",
      body: `The connected watchers can't run: ${labels}. Start a watcher with the matching capability, or these jobs will stay queued.`,
      tone: "danger",
      actionLabel: "Open Jobs",
      action: () => openSection("jobs")
    });
  }

  // A single connected watcher can run ordinary jobs, but it cannot serve the
  // maintenance-orchestrator pattern: gap-closure verification and the patrols claim
  // a job, then block calling back into the API while it waits on freshly-enqueued
  // answer_question jobs — which only ANOTHER watcher can pick up (a watcher runs one
  // job at a time). With just one watcher those follow-ups are never claimed, so the
  // orchestration times out; for gap-closure verification that wrongly reopens a
  // correctly-merged doc (#150). Warn so operators run at least two watchers.
  if (workers.length === 1) {
    notices.push({
      id: "single-watcher",
      title: "Only one watcher is connected",
      body: "Gap-closure verification and the maintenance patrols claim a job and then wait on follow-up AI jobs that a second watcher must run. With a single watcher those follow-ups can't be claimed and the work times out. Run at least two watchers.",
      tone: "warning",
      actionLabel: "Open Jobs",
      action: () => openSection("jobs")
    });
  }

  return notices;
}

// Non-terminal job states. A job is "active" (still moving towards a result)
// until it reaches completed/failed/cancelled.
export function isActiveJob(job: JobView): boolean {
  return job.state === "created" || job.state === "retry" || job.state === "active" || job.state === "blocked";
}

export function jobTransitionMessages(previousJobs: JobView[], nextJobs: JobView[]): JobTransitionMessage[] {
  const previousById = new Map(previousJobs.map((job) => [job.id, job]));

  return nextJobs.flatMap<JobTransitionMessage>((job) => {
    const previous = previousById.get(job.id);
    if (!previous || !isActiveJob(previous) || previous.state === job.state) {
      return [];
    }

    if (job.state === "completed") {
      return [{ text: `${formatJobType(job.type)} completed.`, tone: "success" as const }];
    }

    if (job.state === "failed") {
      return [{ text: `${formatJobType(job.type)} failed. Open Jobs for details.`, tone: "danger" as const }];
    }

    return [];
  });
}

export function formatJobType(type: string): string {
  return (
    type
      .split("_")
      .filter(Boolean)
      // filter(Boolean) guarantees a non-empty segment, but guard the first char
      // anyway so an unexpected empty part can never render the literal "undefined".
      .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : ""))
      .join(" ")
  );
}

// The console-side effects publishing needs, injected so the flow is testable and
// so it *cannot* navigate or long-poll: the deps deliberately exclude openSection
// and the /jobs/:id/wait helper.
export interface PublishProposalDeps {
  apiPost: (path: string, body: unknown) => Promise<{ job?: JobView }>;
  showMessage: (text: string, tone: UiMessage["tone"]) => void;
  refresh: (options: { preserveMessage: boolean }) => Promise<void>;
}

// Publication is enqueue-only on the API, and the console treats it as
// fire-and-forget: enqueue, report "queued", refresh in place. The regular
// polling picks up the watcher's result, so the user keeps working on the page
// they are on instead of being bounced to Jobs behind a blocked UI.
export async function runPublishProposal(deps: PublishProposalDeps, proposalId: string): Promise<void> {
  const result = await deps.apiPost(`/proposals/${proposalId}/publish`, {});
  if (result.job) {
    deps.showMessage(`${formatJobType(result.job.type)} queued. This page will update when it finishes.`, "info");
  }
  await deps.refresh({ preserveMessage: true });
}

// Proposal ids whose publish_proposal job is still in flight. A queued publish
// leaves the proposal record itself untouched (it stays `ready` until the
// watcher reports back), so "publish already requested" is derived from the
// polled jobs list instead — which also self-heals: a publish that fails
// terminally drops out of this set and the button re-enables for a retry.
// The API enforces the same invariant by reusing the in-flight job, so this
// mirror can only mislabel a button, never cause a duplicate.
export function pendingPublishProposalIds(jobs: JobView[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const job of jobs) {
    if (job.type !== "publish_proposal" || !isActiveJob(job)) {
      continue;
    }
    const input = job.input as Partial<{ proposalId: string }>;
    if (input?.proposalId) {
      ids.add(input.proposalId);
    }
  }
  return ids;
}

// The console's bulk review actions, mirroring the API's POST /proposals/bulk
// contract (apps/api/src/features/proposals/routes.ts applyBulkAction).
export type BulkProposalAction = "ready" | "publish" | "merge" | "reject";

export interface BulkProposalResult {
  id: string;
  ok: boolean;
  code?: string;
}

type BulkEligibilityView = Pick<Proposal, "status" | "publication" | "localGitDestination">;

// Client-side mirror of the API's per-action eligibility, used to count/disable
// the bulk bar's buttons. The server re-guards every id, so a stale mirror can
// only mislabel a button, never bypass a guard. `publishPending` marks a
// proposal from pendingPublishProposalIds — publishable by status, but with a
// publish job already in flight.
export function bulkActionEligible(
  action: BulkProposalAction,
  proposal: BulkEligibilityView,
  options: { publishPending?: boolean } = {}
): boolean {
  switch (action) {
    case "ready":
      return proposal.status === "draft";
    case "publish":
      return proposal.status === "ready" && !options.publishPending;
    case "merge":
      // A live pull request owns its own merge transition; manual merge (local
      // Accept or hosted no-PR Mark Merged) needs a pushed branch.
      return proposal.status === "branch-pushed" && !proposal.publication?.pullRequestUrl;
    case "reject":
      // Local-git Bin works on the pushed review branch; hosted Reject only on drafts.
      return proposal.localGitDestination ? proposal.status === "branch-pushed" : proposal.status === "draft";
  }
}

const BULK_SUCCESS_VERBS: Record<BulkProposalAction, (count: number) => string> = {
  ready: (count) => `Marked ${count} proposal${count === 1 ? "" : "s"} ready.`,
  publish: (count) => `Queued ${count} publish job${count === 1 ? "" : "s"}. This page will update as they finish.`,
  merge: (count) =>
    `Merged ${count} proposal${count === 1 ? "" : "s"} — resolving gaps and re-indexing in the background.`,
  reject: (count) => `Rejected ${count} proposal${count === 1 ? "" : "s"}.`
};

// One summary line for a whole batch: the success verb plus a compact skip
// tally by failure code, e.g. "Merged 7 proposals — … Skipped 2: …".
export function bulkOutcomeMessage(
  action: BulkProposalAction,
  results: BulkProposalResult[]
): Pick<UiMessage, "text" | "tone"> {
  const succeeded = results.filter((result) => result.ok).length;
  const failures = results.filter((result) => !result.ok);
  const parts: string[] = [];
  if (succeeded > 0) {
    parts.push(BULK_SUCCESS_VERBS[action](succeeded));
  }
  if (failures.length > 0) {
    const byCode = new Map<string, number>();
    for (const failure of failures) {
      const code = failure.code ?? "error";
      byCode.set(code, (byCode.get(code) ?? 0) + 1);
    }
    const tally = [...byCode.entries()]
      .map(([code, count]) => (count === 1 ? code : `${code} ×${count}`))
      .join(", ");
    parts.push(`Skipped ${failures.length}: ${tally}.`);
  }
  return {
    text: parts.join(" "),
    tone: succeeded === 0 ? "danger" : "success"
  };
}

// Keeps the proposal preview stable across refreshes. If the selected proposal
// survived, keep it. If it dropped out (merged/rejected/binned drop off the
// active list), move to its nearest surviving neighbour in the PREVIOUS list
// order — not back to the top of the list, which is the "page jumps around"
// complaint when working a backlog top to bottom.
export function anchorProposalSelection(
  previous: Array<Pick<Proposal, "id">>,
  next: Array<Pick<Proposal, "id">>,
  selectedId: string | undefined
): string | undefined {
  if (selectedId && next.some((proposal) => proposal.id === selectedId)) {
    return selectedId;
  }
  const fallback = next[0]?.id;
  if (!selectedId) {
    return fallback;
  }
  const previousIndex = previous.findIndex((proposal) => proposal.id === selectedId);
  if (previousIndex === -1) {
    return fallback;
  }
  const nextIds = new Set(next.map((proposal) => proposal.id));
  for (let offset = 1; offset < previous.length; offset++) {
    const after = previous[previousIndex + offset];
    if (after && nextIds.has(after.id)) {
      return after.id;
    }
    const before = previous[previousIndex - offset];
    if (before && nextIds.has(before.id)) {
      return before.id;
    }
  }
  return fallback;
}

// A completed job's output is the queue envelope { result, executor }: the job's
// validated payload lives under `result`, exactly as the MCP kb-client unwraps it.
// Reading job.output directly (e.g. job.output.items) always misses the payload and
// silently yields undefined — the bug that made seed outlines never show documents.
// Returns undefined when the job has no output yet.
export function jobResult<T>(job: Pick<JobView, "output">): T | undefined {
  return (job.output as { result?: T } | undefined)?.result;
}
