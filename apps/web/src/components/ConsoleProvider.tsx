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
  MaintenanceRun,
  Feedback,
  FlowSnapshot,
  GapCandidate,
  Health,
  IndexRepositoryResponse,
  JobsResponse,
  JobType,
  JobView,
  KnowledgeDocument,
  KnowledgeDocumentsResponse,
  KnowledgeRepositoriesResponse,
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
import type { SeedItem } from "@magpie/core";
import { apiDelete, apiGet, apiPost, errorMessage } from "../lib/api";
import { knowledgeFlows } from "../lib/config";
import { buildAttentionNotices, formatJobType, isActiveJob, jobResult, jobTransitionMessages } from "../lib/console";
import { sectionPath } from "../lib/sections";
import { OTHER_DOCUMENTS_ID } from "./KnowledgePanel";

// `/knowledge/documents` and `/knowledge/repositories` are now paginated
// (server default 50, capped at 200 — see apps/api/src/platform/paths.ts
// parseLimit). The console is a single-page operator view that groups
// documents by flow/folder client-side, so it asks for the API's max page
// size rather than adding UI-side pagination controls; large knowledge bases
// beyond 200 items/repos will only show the first page.
const KNOWLEDGE_LIST_LIMIT = 200;

// How often the slow tier (documents, repositories, prompts, config) is
// re-fetched while a job is active. These lists can be large and rarely
// change mid-job, unlike jobs/workers/health/stats, so re-shipping them every
// 4s wastes bandwidth on big knowledge bases. 30s keeps the console
// reasonably current without re-fetching on every fast-tier tick.
const SLOW_POLL_INTERVAL_MS = 30_000;

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
  const [uncoveredJobTypes, setUncoveredJobTypes] = useState<JobType[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | undefined>();
  const [selectedJob, setSelectedJob] = useState<JobView | undefined>();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([]);
  const [maintenanceRuns, setMaintenanceRuns] = useState<MaintenanceRun[]>([]);
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
  // Flow the Ask form pins the question to. "auto" lets the watcher route it; any
  // other value is a configured flow id sent as the /ask `flow` parameter.
  const [askFlow, setAskFlow] = useState("auto");
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
  // from clobbering fresher state. Fast and slow tiers each get their own
  // controller since they now run on independent schedules.
  const refreshControllerRef = useRef<AbortController | undefined>(undefined);
  const slowRefreshControllerRef = useRef<AbortController | undefined>(undefined);

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
    () => buildAttentionNotices({ health, jobs, openSection, stats, workers, uncoveredJobTypes }),
    [health, jobs, openSection, stats, workers, uncoveredJobTypes]
  );
  const selectedProposal = proposals.find((proposal) => proposal.id === selectedProposalId) ?? proposals[0];

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The slow tier (documents, repositories, prompts, config, snapshots) changes
  // far less often than jobs/workers/health/stats, and on a large knowledge base
  // is by far the most expensive part of a refresh. Polling it on its own ~30s
  // timer (independent of whether a job is active) keeps it reasonably current
  // without re-fetching it on every 4s fast-tier tick.
  useEffect(() => {
    const interval = window.setInterval(() => void refreshSlow({ silent: true }), SLOW_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
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

    // Only the fast tier (jobs, workers, health, stats, ...) polls this often;
    // the slow tier (documents, repositories, prompts, config) has its own
    // independent ~30s timer above so large knowledge bases are not re-fetched
    // in full every 4s just because a job is active.
    const interval = window.setInterval(() => void refreshFast({ silent: true }), 4_000);
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

  // Fast tier: jobs, workers, health, stats and the small bounded lists (gaps,
  // questions, proposals, ...) that the active-job 4s poll needs to keep the
  // Jobs/Ask panels live. Never includes the slow tier's large knowledge lists.
  async function refreshFast(options: { preserveMessage?: boolean; silent?: boolean } = {}) {
    // Abort any fast refresh still in flight so its (now stale) response is
    // discarded and never overwrites the state this newer refresh is about to set.
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
        questionsResult,
        gapsResult,
        clustersResult,
        jobsResult,
        schedulesResult,
        workersResult,
        proposalsResult,
        scheduledTasksResult,
        maintenanceRunsResult,
        reconciliationsResult
      ] = await Promise.all([
        apiGet<Health>("/health", { signal }),
        apiGet<KnowledgeStats>("/knowledge/stats", { signal }),
        apiGet<{ questions: QuestionLog[] }>("/questions?limit=8", { signal }),
        apiGet<{ gaps: GapCandidate[] }>("/gaps/candidates?limit=8", { signal }),
        apiGet<{ clusters: SuggestedGapCluster[] }>("/gaps/clusters?limit=8", { signal }),
        apiGet<JobsResponse>("/jobs?limit=100", { signal }),
        apiGet<{ schedules: ScheduleView[] }>("/jobs/schedules", { signal }),
        apiGet<WorkersResponse>("/workers", { signal }),
        apiGet<{ proposals: Proposal[] }>("/proposals?limit=8", { signal }),
        apiGet<{ tasks: ScheduledTask[] }>("/scheduled-tasks", { signal }),
        apiGet<{ runs: MaintenanceRun[] }>("/maintenance-runs?limit=30", { signal }),
        apiGet<{ decisions: ReconciliationDecision[] }>("/reconciliations?limit=20", { signal })
      ]);

      // A newer refresh superseded this one while its requests were in flight;
      // drop the results so we don't clobber the fresher state.
      if (signal.aborted || refreshControllerRef.current !== controller) {
        return;
      }

      setHealth(healthResult);
      setStats(statsResult);
      setQuestions(questionsResult.questions);
      setGaps(gapsResult.gaps);
      setGapClusters(clustersResult.clusters);
      applyJobs(jobsResult.jobs, jobsRef.current.length > 0);
      setJobSchedules(schedulesResult.schedules);
      setWorkers(workersResult.workers);
      setUncoveredJobTypes(workersResult.uncoveredJobTypes);
      setProposals(proposalsResult.proposals);
      setScheduledTasks(scheduledTasksResult.tasks);
      setMaintenanceRuns(maintenanceRunsResult.runs);
      setReconciliationDecisions(reconciliationsResult.decisions);
      setSelectedProposalId((current) => current ?? proposalsResult.proposals[0]?.id);
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

  // Slow tier: the knowledge document/repository lists, prompts, config and flow
  // snapshots. These can be large (now paginated server-side, see
  // KNOWLEDGE_LIST_LIMIT) and change far less often than the fast tier, so they
  // are fetched once on mount, on manual Refresh, and on their own ~30s timer
  // rather than every 4s alongside jobs/workers.
  async function refreshSlow(options: { silent?: boolean } = {}) {
    slowRefreshControllerRef.current?.abort();
    const controller = new AbortController();
    slowRefreshControllerRef.current = controller;
    const { signal } = controller;

    try {
      const [repositoriesResult, documentsResult, configResult, promptsResult, snapshotsResult] = await Promise.all([
        apiGet<KnowledgeRepositoriesResponse>(`/knowledge/repositories?limit=${KNOWLEDGE_LIST_LIMIT}`, { signal }),
        apiGet<KnowledgeDocumentsResponse>(`/knowledge/documents?limit=${KNOWLEDGE_LIST_LIMIT}`, { signal }),
        apiGet<RuntimeConfig>("/config", { signal }),
        apiGet<{ prompts: PromptSummary[] }>("/prompts", { signal }),
        apiGet<{ snapshots: FlowSnapshot[] }>("/snapshots", { signal })
      ]);

      if (signal.aborted || slowRefreshControllerRef.current !== controller) {
        return;
      }

      setRepositories(repositoriesResult.repositories);
      setDocuments(documentsResult.documents);
      setConfig(configResult);
      setPrompts(promptsResult.prompts);
      setFlowSnapshots(snapshotsResult.snapshots);
      setSelectedDocumentId((current) =>
        current && documentsResult.documents.some((document) => document.id === current)
          ? current
          : documentsResult.documents[0]?.id
      );
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      if (!options.silent) {
        showMessage(errorMessage(error), "danger");
      }
    }
  }

  // Used by the mount effect and the manual Refresh button: runs both tiers so
  // every panel is fully current, while the recurring pollers above only ever
  // trigger one tier at a time.
  async function refresh(options: { preserveMessage?: boolean; silent?: boolean } = {}) {
    await Promise.all([refreshFast(options), refreshSlow({ silent: options.silent })]);
  }

  // Shared by the Ask form and the "pick a flow" re-ask. `flow` is "auto" or a
  // configured flow id; the API rejects an unknown id with a 400.
  async function submitQuestion(questionText: string, flow: string) {
    setLoading(true);
    clearMessage();
    try {
      const result = await apiPost<AskResponse>("/ask", { question: questionText, flow });
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

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!question.trim()) {
      return;
    }

    await submitQuestion(question.trim(), askFlow);
  }

  // Re-asks an earlier question that routing could not place, now pinned to a flow
  // the user picked from `flowSelectionRequired`.
  async function reAskWithFlow(questionText: string, flow: string) {
    await submitQuestion(questionText, flow);
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

  async function mergeProposal(proposalId: string) {
    setLoading(true);
    clearMessage();
    try {
      const result = await apiPost<{ proposal: Proposal; cascadeScheduled?: boolean }>(
        `/proposals/${proposalId}/merge`,
        {}
      );
      setProposals((current) => current.map((proposal) => (proposal.id === proposalId ? result.proposal : proposal)));
      setSelectedProposalId(result.proposal.id);
      showMessage(
        "Proposal merged into the local repository — resolving gaps and re-indexing in the background.",
        "success"
      );
      // Merged proposals drop out of the active list; pull fresh proposal/gap state.
      await refresh({ preserveMessage: true });
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    } finally {
      setLoading(false);
    }
  }

  async function rejectProposal(proposalId: string) {
    setLoading(true);
    clearMessage();
    try {
      const result = await apiPost<{ proposal: Proposal }>(`/proposals/${proposalId}/reject`, {});
      setProposals((current) => current.map((proposal) => (proposal.id === proposalId ? result.proposal : proposal)));
      setSelectedProposalId(result.proposal.id);
      showMessage(
        "Proposal binned — the review branch was deleted and its gap cluster frozen so it is not re-proposed.",
        "success"
      );
      // Rejected proposals drop out of the active list; pull fresh state.
      await refresh({ preserveMessage: true });
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

  // Generate a seed outline: enqueue outline_flow_seed and poll it to completion,
  // then hand the proposed items back for the human to edit. The bounded
  // /jobs/:id/wait can return a still-active job when its deadline elapses, so loop
  // until terminal. Returns undefined (and surfaces the error) when generation fails,
  // so the caller can reset its own generating state.
  async function generateOutline(targetFlowId: string, topic: string, notes: string): Promise<SeedItem[] | undefined> {
    clearMessage();
    try {
      const trimmedNotes = notes.trim();
      const { jobId } = await apiPost<{ ok: boolean; jobId: string }>(
        `/flows/${encodeURIComponent(targetFlowId)}/outline`,
        { topic: topic.trim(), notes: trimmedNotes ? trimmedNotes : undefined }
      );
      let job = await waitForJob({ id: jobId });
      while (job.state === "created" || job.state === "retry" || job.state === "active" || job.state === "blocked") {
        job = await waitForJob({ id: jobId });
      }
      if (job.state !== "completed") {
        throw new Error(job.error?.message ?? "Outline generation did not complete.");
      }
      await refresh({ silent: true });
      // The completed job's output is the queue envelope { result, executor }; the
      // outline_flow_seed payload (its items) lives under `result`. Reading
      // job.output.items directly always yields undefined, so the panel would show
      // no proposed documents.
      return jobResult<{ items?: SeedItem[] }>(job)?.items ?? [];
    } catch (error) {
      showMessage(errorMessage(error), "danger");
      return undefined;
    }
  }

  // Seed a flow with the reviewed items: POST the v1 endpoint, which drafts one
  // document per item into the proposal → PR pipeline. Returns the enqueued job ids
  // (undefined on failure, with the error surfaced).
  async function seedFlow(targetFlowId: string, items: SeedItem[]): Promise<string[] | undefined> {
    clearMessage();
    try {
      const { jobIds } = await apiPost<{ ok: boolean; jobIds: string[] }>(
        `/flows/${encodeURIComponent(targetFlowId)}/seed`,
        { items }
      );
      showMessage(
        `Seeding ${jobIds.length} document${jobIds.length === 1 ? "" : "s"} into the flow — drafts will appear as proposals.`,
        "success"
      );
      await refresh({ preserveMessage: true });
      return jobIds;
    } catch (error) {
      showMessage(errorMessage(error), "danger");
      return undefined;
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
    maintenanceRuns,
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
    askFlow,
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
    setAskFlow,
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
    reAskWithFlow,
    sendFeedback,
    toggleKnowledgeGap,
    draftProposal,
    draftCluster,
    updateProposalStatus,
    mergeProposal,
    rejectProposal,
    publishProposal,
    saveScheduledTask,
    runScheduledTask,
    indexRepository,
    generateOutline,
    seedFlow
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
