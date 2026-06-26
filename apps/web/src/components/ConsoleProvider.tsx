"use client";

import { useRouter } from "next/navigation";
import {
  FormEvent,
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  AskResponse,
  ConsoleSection,
  Feedback,
  FlowSnapshot,
  GapCandidate,
  Health,
  IndexRepositoryResponse,
  JobsResponse,
  JobView,
  KnowledgeDocument,
  KnowledgeStats,
  PromptSummary,
  Proposal,
  QuestionLog,
  ReconciliationDecision,
  RepositoryRef,
  RuntimeConfig,
  ScheduledTask,
  ScheduleView,
  SuggestedGapCluster,
  UiMessage,
  WatcherView,
  WorkersResponse
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
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [jobSchedules, setJobSchedules] = useState<ScheduleView[]>([]);
  const [workers, setWorkers] = useState<WatcherView[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | undefined>();
  const [selectedJob, setSelectedJob] = useState<JobView | undefined>();
  const [proposals, setProposals] = useState<Proposal[]>([]);
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
  const jobsRef = useRef<JobView[]>([]);
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
    () => buildAttentionNotices({ health, jobs, openSection, stats }),
    [health, jobs, openSection, stats]
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
    const hasActiveWork = jobs.some(isActiveJob) || (answer?.job ? isActiveJob(answer.job) : false);

    if (!hasActiveWork) {
      return;
    }

    const interval = window.setInterval(() => void refresh({ silent: true }), 4_000);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answer?.job?.id, answer?.job?.state, jobs]);

  function showMessage(text: string, tone: UiMessage["tone"] = "info") {
    setMessage({ id: messageIdRef.current++, text, tone });
  }

  function clearMessage() {
    setMessage(undefined);
  }

  // The one reusable wait helper used after every enqueue (ask, proposal draft,
  // gap-cluster draft, manual scheduled-task run). It long-polls the
  // API's bounded `/jobs/:id/wait`, which returns the terminal job when the
  // watcher finishes, or the still-active view if its deadline elapses first —
  // in which case the normal 4s refresh polling keeps the UI updating.
  async function waitForJob(job: Pick<JobView, "id">): Promise<JobView> {
    const waited = await apiGet<{ job: JobView }>(`/jobs/${job.id}/wait`);
    return waited.job;
  }

  async function acceptFailedJobs(jobIds: string[]) {
    clearMessage();
    try {
      const results = await Promise.all(
        jobIds.map((jobId) => apiPost<{ job: JobView }>(`/jobs/${jobId}/accept-failure`, {}))
      );
      const selected = results.find((result) => result.job.id === selectedJobId);
      if (selected) setSelectedJob(selected.job);
      showMessage(`${jobIds.length} failed job${jobIds.length === 1 ? "" : "s"} accepted.`, "success");
      await refresh({ preserveMessage: true });
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    }
  }

  async function selectJob(jobId: string) {
    setSelectedJobId(jobId);
    clearMessage();
    try {
      const result = await apiGet<{ job: JobView }>(`/jobs/${jobId}`);
      setSelectedJob(result.job);
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    }
  }

  function clearSelectedJob() {
    setSelectedJobId(undefined);
    setSelectedJob(undefined);
  }

  async function cancelJob(jobId: string) {
    clearMessage();
    try {
      const result = await apiPost<{ job: JobView }>(`/jobs/${jobId}/cancel`, {});
      if (selectedJobId === jobId) {
        setSelectedJob(result.job);
      }
      showMessage("Job cancelled.", "success");
      await refresh({ preserveMessage: true });
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    }
  }

  async function retryJob(jobId: string) {
    clearMessage();
    try {
      const result = await apiPost<{ job: JobView }>(`/jobs/${jobId}/retry`, {});
      if (selectedJobId === jobId) {
        setSelectedJob(result.job);
      }
      showMessage("Job re-queued for retry.", "success");
      await refresh({ preserveMessage: true });
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    }
  }

  function toggleCitations(questionId: string) {
    setExpandedQuestionIds((current) =>
      current.includes(questionId) ? current.filter((id) => id !== questionId) : [...current, questionId]
    );
  }

  function applyJobs(nextJobs: JobView[], notify: boolean) {
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
      const [
        healthResult,
        statsResult,
        repositoriesResult,
        documentsResult,
        questionsResult,
        gapsResult,
        clustersResult,
        jobsResult,
        schedulesResult,
        workersResult,
        proposalsResult,
        scheduledTasksResult,
        configResult,
        promptsResult,
        snapshotsResult,
        reconciliationsResult
      ] = await Promise.all([
        apiGet<Health>("/health", { signal }),
        apiGet<KnowledgeStats>("/knowledge/stats", { signal }),
        apiGet<{ repositories: RepositoryRef[] }>("/knowledge/repositories", { signal }),
        apiGet<{ documents: KnowledgeDocument[] }>("/knowledge/documents", { signal }),
        apiGet<{ questions: QuestionLog[] }>("/questions?limit=8", { signal }),
        apiGet<{ gaps: GapCandidate[] }>("/gaps/candidates?limit=8", { signal }),
        apiGet<{ clusters: SuggestedGapCluster[] }>("/gaps/clusters?limit=8", { signal }),
        apiGet<JobsResponse>("/jobs?limit=100", { signal }),
        apiGet<{ schedules: ScheduleView[] }>("/jobs/schedules", { signal }),
        apiGet<WorkersResponse>("/workers", { signal }),
        apiGet<{ proposals: Proposal[] }>("/proposals?limit=8", { signal }),
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
      setJobSchedules(schedulesResult.schedules);
      setWorkers(workersResult.workers);
      setProposals(proposalsResult.proposals);
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

      // The ask response is enqueue-only: the answer lands on the question log
      // (rendered by the answered-questions list) once the watcher completes the
      // job. Keep the live `answer.job` view fresh from the jobs list so the
      // queued/active/terminal status the AskPanel shows tracks reality.
      setAnswer((current) =>
        current ? { ...current, job: jobsResult.jobs.find((job) => job.id === current.job.id) ?? current.job } : current
      );

      // Keep the Jobs-panel detail pane current while the operator has a job open.
      if (selectedJobId) {
        const fresh = jobsResult.jobs.find((job) => job.id === selectedJobId);
        if (fresh) {
          setSelectedJob(fresh);
        }
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
      setQuestion("");
      // Bounded-wait for the queued answer; the helper returns the terminal job
      // (or the still-active view if the watcher is slow), and the 4s refresh
      // polling keeps the answered-questions list updating either way.
      const job = await waitForJob(result.job);
      setAnswer({ ...result, job });
      showMessage(
        isActiveJob(job)
          ? `${formatJobType(job.type)} queued. We will update this page when it finishes.`
          : `${formatJobType(job.type)} ${job.state}.`,
        job.state === "failed" ? "danger" : "info"
      );
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
      const result = await apiPost<{ job?: JobView; proposal?: Proposal }>("/proposals/from-gap", {
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
        const job = await waitForJob(result.job);
        showMessage(
          isActiveJob(job)
            ? `${formatJobType(job.type)} queued. We will update this page when it finishes.`
            : `${formatJobType(job.type)} ${job.state}.`,
          job.state === "failed" ? "danger" : "info"
        );
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
      const result = await apiPost<{ job?: JobView; proposal?: Proposal }>("/proposals/from-gaps", {
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
        const job = await waitForJob(result.job);
        showMessage(
          isActiveJob(job)
            ? `${formatJobType(job.type)} queued. We will update this page when it finishes.`
            : `${formatJobType(job.type)} ${job.state}.`,
          job.state === "failed" ? "danger" : "info"
        );
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
      // Publication is now enqueue-only: the API validates and returns a queued
      // publish_proposal job. The watcher executes the git and records the
      // publication back onto the proposal, which a later refresh picks up.
      const result = await apiPost<{ job?: JobView }>(`/proposals/${proposalId}/publish`, {});
      openSection("jobs");
      if (result.job) {
        const job = await waitForJob(result.job);
        showMessage(
          isActiveJob(job)
            ? `${formatJobType(job.type)} queued. We will update this page when it finishes.`
            : `${formatJobType(job.type)} ${job.state}.`,
          job.state === "failed" ? "danger" : "info"
        );
      }
      await refresh({ preserveMessage: true });
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    } finally {
      setLoading(false);
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
      const result = await apiPost<{ job: JobView; tasks: ScheduledTask[] }>(`/scheduled-tasks/${key}/run`, {});
      setScheduledTasks(result.tasks);
      const job = await waitForJob(result.job);
      showMessage(
        isActiveJob(job)
          ? "Side-process queued; it runs on the watcher in the background."
          : `Side-process ${job.state}.`,
        job.state === "failed" ? "danger" : "success"
      );
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
    jobSchedules,
    workers,
    selectedJobId,
    selectedJob,
    proposals,
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
    selectJob,
    clearSelectedJob,
    cancelJob,
    retryJob,
    acceptFailedJobs,
    ask,
    sendFeedback,
    toggleKnowledgeGap,
    draftProposal,
    draftCluster,
    updateProposalStatus,
    publishProposal,
    saveScheduledTask,
    runScheduledTask,
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
