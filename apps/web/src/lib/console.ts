import { ConsoleNotice, ConsoleSection, Health, JobTransitionMessage, JobType, JobView, KnowledgeStats, WatcherView } from "./types";

export function sectionTitle(section: ConsoleSection): string {
  if (section === "knowledge") {
    return "Manage knowledge flows";
  }
  if (section === "gaps") {
    return "Turn weak answers into proposals";
  }
  if (section === "seed") {
    return "Seed a flow or add a new area";
  }
  if (section === "jobs") {
    return "Watch AI and MCP job flow";
  }
  if (section === "activity") {
    return "Audit background activity";
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
    return "Generate an outline for a topic, edit the proposed documents, and draft them straight into review — bypassing the demand-driven gap pipeline.";
  }
  if (section === "jobs") {
    return "See queued, claimed, completed, and failed AI work in one stable table.";
  }
  if (section === "activity") {
    return "Review the durable maintenance-run audit for scheduled and manual background work.";
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
