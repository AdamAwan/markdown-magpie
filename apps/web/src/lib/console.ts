import { AiJob, ConsoleNotice, ConsoleSection, Health, JobTransitionMessage, KnowledgeStats, RuntimeConfig } from "./types";

export function sectionTitle(section: ConsoleSection): string {
  if (section === "knowledge") {
    return "Browse the Markdown knowledge base";
  }
  if (section === "gaps") {
    return "Turn weak answers into proposals";
  }
  if (section === "jobs") {
    return "Watch AI and MCP job flow";
  }
  if (section === "proposals") {
    return "Review generated Markdown proposals";
  }
  if (section === "crunch") {
    return "Keep the knowledge base tidy";
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

  return "Ask and inspect cited answers";
}

export function sectionSubtitle(section: ConsoleSection): string {
  if (section === "knowledge") {
    return "Read indexed Markdown documents, search sections, and add new knowledge from one workspace.";
  }
  if (section === "gaps") {
    return "Prioritize repeated gaps and draft Markdown updates from them.";
  }
  if (section === "jobs") {
    return "See queued, claimed, completed, and failed AI work in one stable table.";
  }
  if (section === "proposals") {
    return "Select a proposal and review its target path, rationale, and Markdown.";
  }
  if (section === "crunch") {
    return "Schedule an AI pass that consolidates overlapping docs and splits bloated ones, then review and publish the tidy as a branch.";
  }
  if (section === "prompts") {
    return "Read the exact instruction text sent to the AI for each job type, and where each prompt is used.";
  }
  if (section === "dataflow") {
    return "Understand how Markdown, embeddings, questions, and proposals flow through the system.";
  }
  if (section === "config") {
    return "Check execution mode, stores, providers, repository paths, and whether secrets are set.";
  }

  return "Ask and inspect cited answers";
}

export function buildAttentionNotices({
  config,
  health,
  jobs,
  openSection,
  stats
}: {
  config?: RuntimeConfig;
  health?: Health;
  jobs: AiJob[];
  openSection: (section: ConsoleSection) => void;
  stats: KnowledgeStats;
}): ConsoleNotice[] {
  const notices: ConsoleNotice[] = [];
  const pendingJobs = jobs.filter((job) => job.status === "pending" || job.status === "claimed");
  const failedJobs = jobs.filter((job) => job.status === "failed");

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

  if (config?.aiRuntime.executionMode === "queue" && pendingJobs.length > 0) {
    notices.push({
      id: "queue-waiting",
      title: `${pendingJobs.length} queued job${pendingJobs.length === 1 ? "" : "s"} waiting`,
      body: "Queue mode needs the watcher process. If these jobs stay pending after refresh, start the watcher or switch to direct mode.",
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

  return notices;
}

export function isActiveJob(job: AiJob): boolean {
  return job.status === "pending" || job.status === "claimed";
}

export function jobTransitionMessages(previousJobs: AiJob[], nextJobs: AiJob[]): JobTransitionMessage[] {
  const previousById = new Map(previousJobs.map((job) => [job.id, job]));

  return nextJobs.flatMap<JobTransitionMessage>((job) => {
    const previous = previousById.get(job.id);
    if (!previous || !isActiveJob(previous) || previous.status === job.status) {
      return [];
    }

    if (job.status === "completed") {
      return [{ text: `${formatJobType(job.type)} completed.`, tone: "success" as const }];
    }

    if (job.status === "failed") {
      return [{ text: `${formatJobType(job.type)} failed. Open Jobs for details.`, tone: "danger" as const }];
    }

    return [];
  });
}

export function formatJobType(type: string): string {
  return type
    .split("_")
    .filter(Boolean)
    // filter(Boolean) guarantees a non-empty segment, but guard the first char
    // anyway so an unexpected empty part can never render the literal "undefined".
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : ""))
    .join(" ");
}
