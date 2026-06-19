"use client";

import { useRouter } from "next/navigation";
import { FormEvent, ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  AiJob,
  AskResponse,
  ConsoleSection,
  CrunchRun,
  CrunchSettings,
  Feedback,
  FlowSnapshot,
  GapCandidate,
  Health,
  IndexRepositoryResponse,
  KnowledgeDocument,
  KnowledgeStats,
  PromptSummary,
  Proposal,
  QuestionLog,
  ReconciliationDecision,
  RepositoryRef,
  RuntimeConfig,
  ScheduledTask,
  SuggestedGapCluster,
  UiMessage
} from "../lib/types";
import { apiDelete, apiGet, apiPost, errorMessage } from "../lib/api";
import { knowledgeFlows } from "../lib/config";
import { buildAttentionNotices, formatJobType, isActiveJob, jobTransitionMessages } from "../lib/console";
import { sectionPath } from "../lib/sections";
import { OTHER_DOCUMENTS_ID } from "./KnowledgePanel";

// Holds every piece of console state, the data-loading effects and the action
// handlers that previously lived inline in the single page component. Lifting
// them into a provider mounted by the root layout means the state and the 4s
// polling survive client-side navigation between section routes, so moving
// between sections never re-fetches and a refresh restores the same data.
function useConsoleController() {
  const router = useRouter();

  const [health, setHealth] = useState<Health | undefined>();
  const [stats, setStats] = useState<KnowledgeStats>({ repositoryCount: 0, documentCount: 0, sectionCount: 0 });
  const [questions, setQuestions] = useState<QuestionLog[]>([]);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [repositories, setRepositories] = useState<RepositoryRef[]>([]);
  const [gaps, setGaps] = useState<GapCandidate[]>([]);
  const [gapClusters, setGapClusters] = useState<SuggestedGapCluster[]>([]);
  const [jobs, setJobs] = useState<AiJob[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [crunchRuns, setCrunchRuns] = useState<CrunchRun[]>([]);
  const [crunchSettings, setCrunchSettings] = useState<CrunchSettings[]>([]);
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([]);
  const [prompts, setPrompts] = useState<PromptSummary[]>([]);
  const [flowSnapshots, setFlowSnapshots] = useState<FlowSnapshot[]>([]);
  const [reconciliationDecisions, setReconciliationDecisions] = useState<ReconciliationDecision[]>([]);
  const [config, setConfig] = useState<RuntimeConfig | undefined>();
  const [selectedProposalId, setSelectedProposalId] = useState<string | undefined>();
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | undefined>();
  const [expandedQuestionIds, setExpandedQuestionIds] = useState<string[]>([]);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AskResponse | undefined>();
  const [answeredSearch, setAnsweredSearch] = useState("");
  // Starts empty; a reconciliation effect selects the first configured flow once
  // config loads, so no demo-specific id is baked into the default state.
  const [flowId, setFlowId] = useState("");
  const [loading, setLoading] = useState(false);
  const [indexingRepo, setIndexingRepo] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | undefined>();
  const [message, setMessage] = useState<UiMessage | undefined>();
  const jobsRef = useRef<AiJob[]>([]);
  const messageIdRef = useRef(0);
  // Holds the AbortController for the in-flight refresh. The 4s poll and a manual
  // Refresh can overlap; aborting the previous request before starting a new one
  // (and ignoring a superseded controller's results) stops a slow stale response
  // from clobbering fresher state.
  const refreshControllerRef = useRef<AbortController | undefined>(undefined);

  const openSection = useCallback(
    (section: ConsoleSection) => {
      router.push(sectionPath(section));
    },
    [router]
  );

  const latestJob = useMemo(
    () => [...jobs].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0],
    [jobs]
  );
  const attentionNotices = useMemo(
    () => buildAttentionNotices({ config, health, jobs, openSection, stats }),
    [config, health, jobs, openSection, stats]
  );
  const selectedProposal = proposals.find((proposal) => proposal.id === selectedProposalId) ?? proposals[0];

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const configuredFlowIds = knowledgeFlows(config).map((flow) => flow.id);
    if (configuredFlowIds.length > 0 && flowId !== OTHER_DOCUMENTS_ID && !configuredFlowIds.includes(flowId)) {
      setFlowId(configuredFlowIds[0]);
    }
  }, [config, flowId]);

  useEffect(() => {
    if (!message) {
      return;
    }

    const timeout = window.setTimeout(() => setMessage(undefined), message.tone === "danger" ? 10_000 : 5_000);
    return () => window.clearTimeout(timeout);
  }, [message]);

  useEffect(() => {
    const hasActiveWork =
      jobs.some(isActiveJob) ||
      crunchRuns.some((run) => run.status === "running" || run.status === "pending") ||
      (answer?.job ? isActiveJob(answer.job) : false) ||
      (answer?.mode === "queue" && !answer.result);

    if (!hasActiveWork) {
      return;
    }

    const interval = window.setInterval(() => void refresh({ silent: true }), 4_000);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answer?.job?.id, answer?.job?.status, answer?.mode, answer?.result, jobs, crunchRuns]);

  function showMessage(text: string, tone: UiMessage["tone"] = "info") {
    setMessage({ id: messageIdRef.current++, text, tone });
  }

  function clearMessage() {
    setMessage(undefined);
  }

  function toggleCitations(questionId: string) {
    setExpandedQuestionIds((current) =>
      current.includes(questionId) ? current.filter((id) => id !== questionId) : [...current, questionId]
    );
  }

  function applyJobs(nextJobs: AiJob[], notify: boolean) {
    const notices = notify ? jobTransitionMessages(jobsRef.current, nextJobs) : [];
    jobsRef.current = nextJobs;
    setJobs(nextJobs);
    if (notices.length > 0) {
      const failed = notices.some((notice) => notice.tone === "danger");
      showMessage(notices.map((notice) => notice.text).join(" "), failed ? "danger" : "success");
    }
  }

  async function refresh(options: { preserveMessage?: boolean; silent?: boolean } = {}) {
    // Abort any refresh still in flight so its (now stale) response is discarded
    // and never overwrites the state this newer refresh is about to set.
    refreshControllerRef.current?.abort();
    const controller = new AbortController();
    refreshControllerRef.current = controller;
    const { signal } = controller;

    setRefreshing(true);
    if (!options.silent && !options.preserveMessage) {
      clearMessage();
    }
    try {
      const [healthResult, statsResult, repositoriesResult, documentsResult, questionsResult, gapsResult, clustersResult, jobsResult, proposalsResult, crunchRunsResult, crunchSettingsResult, scheduledTasksResult, configResult, promptsResult, snapshotsResult, reconciliationsResult] = await Promise.all([
        apiGet<Health>("/health", { signal }),
        apiGet<KnowledgeStats>("/knowledge/stats", { signal }),
        apiGet<{ repositories: RepositoryRef[] }>("/knowledge/repositories", { signal }),
        apiGet<{ documents: KnowledgeDocument[] }>("/knowledge/documents", { signal }),
        apiGet<{ questions: QuestionLog[] }>("/questions?limit=8", { signal }),
        apiGet<{ gaps: GapCandidate[] }>("/gaps/candidates?limit=8", { signal }),
        apiGet<{ clusters: SuggestedGapCluster[] }>("/gaps/clusters?limit=8", { signal }),
        apiGet<{ jobs: AiJob[] }>("/ai-jobs", { signal }),
        apiGet<{ proposals: Proposal[] }>("/proposals?limit=8", { signal }),
        apiGet<{ runs: CrunchRun[] }>("/crunch/runs?limit=12", { signal }),
        apiGet<{ settings: CrunchSettings[] }>("/crunch/settings", { signal }),
        apiGet<{ tasks: ScheduledTask[] }>("/scheduled-tasks", { signal }),
        apiGet<RuntimeConfig>("/config", { signal }),
        apiGet<{ prompts: PromptSummary[] }>("/prompts", { signal }),
        apiGet<{ snapshots: FlowSnapshot[] }>("/snapshots", { signal }),
        apiGet<{ decisions: ReconciliationDecision[] }>("/reconciliations?limit=20", { signal })
      ]);

      // A newer refresh superseded this one while its requests were in flight;
      // drop the results so we don't clobber the fresher state.
      if (signal.aborted || refreshControllerRef.current !== controller) {
        return;
      }

      setHealth(healthResult);
      setStats(statsResult);
      setRepositories(repositoriesResult.repositories);
      setDocuments(documentsResult.documents);
      setQuestions(questionsResult.questions);
      setGaps(gapsResult.gaps);
      setGapClusters(clustersResult.clusters);
      applyJobs(jobsResult.jobs, jobsRef.current.length > 0);
      setProposals(proposalsResult.proposals);
      setCrunchRuns(crunchRunsResult.runs);
      setCrunchSettings(crunchSettingsResult.settings);
      setScheduledTasks(scheduledTasksResult.tasks);
      setPrompts(promptsResult.prompts);
      setFlowSnapshots(snapshotsResult.snapshots);
      setReconciliationDecisions(reconciliationsResult.decisions);
      setConfig(configResult);
      setSelectedProposalId((current) => current ?? proposalsResult.proposals[0]?.id);
      setSelectedDocumentId((current) =>
        current && documentsResult.documents.some((document) => document.id === current)
          ? current
          : documentsResult.documents[0]?.id
      );
      setLastRefreshedAt(new Date().toISOString());

      if (answer?.questionId) {
        const result = await apiGet<{ question: QuestionLog }>(`/questions/${answer.questionId}`, { signal });
        if (signal.aborted || refreshControllerRef.current !== controller) {
          return;
        }
        setAnswer((current) =>
          current?.questionId === result.question.id
            ? {
                ...current,
                mode: result.question.executionMode,
                result: result.question.answer,
                job: jobsResult.jobs.find((job) => job.id === current.job?.id) ?? current.job
              }
            : current
        );
      }
    } catch (error) {
      // A superseded/aborted refresh raising AbortError is expected — stay quiet.
      if (signal.aborted) {
        return;
      }
      if (!options.silent) {
        showMessage(errorMessage(error), "danger");
      }
    } finally {
      // Only the latest refresh owns the spinner; a superseded one must not clear
      // it out from under the refresh that replaced it.
      if (refreshControllerRef.current === controller) {
        setRefreshing(false);
      }
    }
  }

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!question.trim()) {
      return;
    }

    setLoading(true);
    clearMessage();
    try {
      const result = await apiPost<AskResponse>("/ask", { question: question.trim() });
      setAnswer(result);
      setQuestion("");
      if (result.job) {
        showMessage(`${formatJobType(result.job.type)} queued. We will update this page when it finishes.`, "info");
      }
      await refresh({ preserveMessage: true });
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    } finally {
      setLoading(false);
    }
  }

  async function sendFeedback(questionId: string, feedback: Feedback) {
    clearMessage();
    try {
      const result = await apiPost<{ question: QuestionLog }>(`/questions/${questionId}/feedback`, { feedback });
      setQuestions((current) => current.map((item) => (item.id === questionId ? result.question : item)));
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    }
  }

  async function toggleKnowledgeGap(questionId: string, flagged: boolean) {
    clearMessage();
    try {
      const result = flagged
        ? await apiPost<{ question: QuestionLog }>(`/questions/${questionId}/gap`, {})
        : await apiDelete<{ question: QuestionLog }>(`/questions/${questionId}/gap`);
      setQuestions((current) => current.map((item) => (item.id === questionId ? result.question : item)));
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    }
  }

  async function draftProposal(gap: GapCandidate) {
    setLoading(true);
    clearMessage();
    try {
      const result = await apiPost<{ job?: AiJob; proposal?: Proposal }>("/proposals/from-gap", {
        summary: gap.summary,
        // Draft into the flow the gap actually came from; fall back to the
        // console's selected flow for un-routed/legacy gaps.
        flowId: gap.flowId ?? flowId
      });
      if (result.proposal) {
        setSelectedProposalId(result.proposal.id);
        openSection("proposals");
      } else {
        openSection("jobs");
      }
      if (result.job) {
        showMessage(`${formatJobType(result.job.type)} queued. We will update this page when it finishes.`, "info");
      }
      await refresh({ preserveMessage: true });
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    } finally {
      setLoading(false);
    }
  }

  async function draftCluster(summaries: string[], clusterFlowId?: string) {
    if (summaries.length === 0) {
      return;
    }
    setLoading(true);
    clearMessage();
    try {
      const result = await apiPost<{ job?: AiJob; proposal?: Proposal }>("/proposals/from-gaps", {
        summaries,
        // Use the cluster's own flow (clusters are per-flow); fall back to the
        // console's selected flow when the cluster carries none.
        flowId: clusterFlowId ?? flowId
      });
      if (result.proposal) {
        setSelectedProposalId(result.proposal.id);
        openSection("proposals");
      } else {
        openSection("jobs");
      }
      if (result.job) {
        showMessage(`${formatJobType(result.job.type)} queued. We will update this page when it finishes.`, "info");
      }
      await refresh({ preserveMessage: true });
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    } finally {
      setLoading(false);
    }
  }

  async function updateProposalStatus(proposalId: string, status: Proposal["status"]) {
    setLoading(true);
    clearMessage();
    try {
      const result = await apiPost<{ proposal: Proposal; cascadeScheduled?: boolean }>(
        `/proposals/${proposalId}/status`,
        { status }
      );
      setProposals((current) => current.map((proposal) => (proposal.id === proposalId ? result.proposal : proposal)));
      setSelectedProposalId(result.proposal.id);
      if (status === "merged") {
        // The merge is recorded immediately; resolving gaps and re-indexing the
        // destination now run in the background, so the result is eventually
        // consistent. Refresh shortly after to pick up the cascade's effects.
        showMessage("Proposal merged — resolving gaps and re-indexing in the background.", "success");
        // Merged proposals drop out of the active list and their gaps stop
        // surfacing, so pull fresh proposal and gap state.
        await refresh({ preserveMessage: true });
      } else {
        showMessage(status === "ready" ? "Proposal marked ready for PR workflow." : "Proposal rejected.", "success");
      }
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    } finally {
      setLoading(false);
    }
  }

  async function publishProposal(proposalId: string) {
    setLoading(true);
    clearMessage();
    try {
      const result = await apiPost<{ proposal: Proposal; pullRequestUrl?: string; pullRequestWarning?: string }>(
        `/proposals/${proposalId}/publish`,
        {}
      );
      setProposals((current) => current.map((proposal) => (proposal.id === proposalId ? result.proposal : proposal)));
      setSelectedProposalId(result.proposal.id);
      const branchLabel = result.proposal.publication?.branchName ?? "proposal branch";
      if (result.pullRequestUrl) {
        showMessage(`Published ${branchLabel} and opened a pull request.`, "success");
      } else if (result.pullRequestWarning) {
        showMessage(`Published ${branchLabel}, but PR creation failed: ${result.pullRequestWarning}`, "info");
      } else {
        showMessage(`Published ${branchLabel} (no PR raised — configure a host token to enable).`, "success");
      }
      await refresh({ preserveMessage: true });
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    } finally {
      setLoading(false);
    }
  }

  async function runCrunch(targetFlowId?: string) {
    setLoading(true);
    clearMessage();
    try {
      const result = await apiPost<{ run: CrunchRun }>("/crunch/run", { flowId: targetFlowId });
      if (result.run.status === "completed") {
        showMessage(`Crunch finished: ${result.run.plan?.summary ?? "plan ready"}`, "success");
      } else if (result.run.status === "failed") {
        showMessage(`Crunch failed: ${result.run.error ?? "unknown error"}`, "danger");
      } else {
        showMessage("Crunch queued. We will update this page when it finishes.", "info");
      }
      await refresh({ preserveMessage: true });
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    } finally {
      setLoading(false);
    }
  }

  async function saveCrunchSchedule(targetFlowId: string | undefined, enabled: boolean, cron: string) {
    clearMessage();
    try {
      const result = await apiPost<{ settings: CrunchSettings[] }>("/crunch/settings", {
        flowId: targetFlowId,
        enabled,
        cron
      });
      setCrunchSettings(result.settings);
      showMessage(enabled ? "Crunch schedule enabled." : "Crunch schedule disabled.", "success");
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    }
  }

  async function saveScheduledTask(key: string, enabled: boolean, cron: string) {
    clearMessage();
    try {
      const result = await apiPost<{ tasks: ScheduledTask[] }>(`/scheduled-tasks/${key}/settings`, { enabled, cron });
      setScheduledTasks(result.tasks);
      showMessage(enabled ? "Side-process schedule enabled." : "Side-process schedule disabled.", "success");
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    }
  }

  async function runScheduledTask(key: string) {
    setLoading(true);
    clearMessage();
    try {
      const result = await apiPost<{ tasks: ScheduledTask[] }>(`/scheduled-tasks/${key}/run`, {});
      setScheduledTasks(result.tasks);
      showMessage("Side-process started; it runs in the background.", "success");
      await refresh({ preserveMessage: true });
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    } finally {
      setLoading(false);
    }
  }

  async function publishCrunchRun(runId: string) {
    setLoading(true);
    clearMessage();
    try {
      const result = await apiPost<{ run: CrunchRun }>(`/crunch/runs/${runId}/publish`, {});
      setCrunchRuns((current) => current.map((run) => (run.id === runId ? result.run : run)));
      showMessage(`Published ${result.run.publication?.branchName ?? "crunch branch"}.`, "success");
      await refresh({ preserveMessage: true });
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    } finally {
      setLoading(false);
    }
  }

  async function indexRepository(nextFlowId = flowId) {
    if (!nextFlowId.trim()) {
      return;
    }

    setIndexingRepo(true);
    clearMessage();
    try {
      const summary = await apiPost<IndexRepositoryResponse>("/knowledge/repositories/index", {
        flowId: nextFlowId.trim()
      });
      showMessage(
        `Indexed ${summary.repository.name} with ${summary.documentCount} documents and ${summary.sectionCount} sections.`,
        "success"
      );
      await refresh({ preserveMessage: true });
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    } finally {
      setIndexingRepo(false);
    }
  }

  return {
    health,
    stats,
    questions,
    documents,
    repositories,
    gaps,
    gapClusters,
    jobs,
    proposals,
    crunchRuns,
    crunchSettings,
    scheduledTasks,
    prompts,
    flowSnapshots,
    reconciliationDecisions,
    config,
    selectedProposalId,
    selectedDocumentId,
    selectedProposal,
    expandedQuestionIds,
    question,
    answer,
    answeredSearch,
    flowId,
    loading,
    indexingRepo,
    refreshing,
    lastRefreshedAt,
    message,
    latestJob,
    attentionNotices,
    setConfig,
    setSelectedProposalId,
    setSelectedDocumentId,
    setFlowId,
    setAnsweredSearch,
    setQuestion,
    showMessage,
    clearMessage,
    toggleCitations,
    openSection,
    refresh,
    ask,
    sendFeedback,
    toggleKnowledgeGap,
    draftProposal,
    draftCluster,
    updateProposalStatus,
    publishProposal,
    runCrunch,
    saveCrunchSchedule,
    saveScheduledTask,
    runScheduledTask,
    publishCrunchRun,
    indexRepository
  };
}

type ConsoleContextValue = ReturnType<typeof useConsoleController>;

const ConsoleContext = createContext<ConsoleContextValue | null>(null);

export function ConsoleProvider({ children }: { children: ReactNode }) {
  const value = useConsoleController();
  return <ConsoleContext.Provider value={value}>{children}</ConsoleContext.Provider>;
}

export function useConsole(): ConsoleContextValue {
  const context = useContext(ConsoleContext);
  if (!context) {
    throw new Error("useConsole must be used within a ConsoleProvider");
  }
  return context;
}
