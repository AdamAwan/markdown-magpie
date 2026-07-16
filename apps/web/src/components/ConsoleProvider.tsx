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
  QuestionDeletionReport,
  QuestionLog,
  ReconciliationDecision,
  RepositoryRef,
  RuntimeConfig,
  ScheduledTask,
  ScheduleView,
  SourceMapEntry,
  SourceMapResponse,
  SuggestedGapCluster,
  UiNotification,
  WatcherView,
  WorkersResponse
} from "../lib/types";
import type { SeedPlan } from "@magpie/core";
import { apiDelete, apiGet, apiPatch, apiPost, errorMessage } from "../lib/api";
import { knowledgeFlows } from "../lib/config";
import {
  BulkProposalAction,
  BulkProposalResult,
  anchorProposalSelection,
  buildAttentionNotices,
  bulkOutcomeMessage,
  formatJobType,
  isActiveJob,
  jobTransitionMessages,
  runPublishProposal
} from "../lib/console";
import { sectionPath } from "../lib/sections";
import { OTHER_DOCUMENTS_ID } from "./KnowledgePanel";

// Mirrors the API's seed-plan PATCH body (apps/api/src/features/seed/schema.ts):
// reviewer edits to charter/persona text plus per-item field edits and status
// flips, addressed by the items' stable ids.
export interface SeedPlanPatchBody {
  charter?: string;
  persona?: string;
  items?: Array<{
    id: string;
    title?: string;
    targetPath?: string;
    coverage?: string[];
    questions?: string[];
    status?: "proposed" | "approved" | "dismissed";
  }>;
}

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

// The proposals page is a review workbench over the whole active backlog, and
// the bulk bar's select-all must cover it — so this matches the jobs list's
// page rather than the other fast-tier lists' 8-item windows. Proposals carry
// their full markdown, so this is the fast tier's heaviest fetch; if it ever
// becomes a problem the fix is a summary field-set on GET /proposals, not a
// smaller window here.
const PROPOSALS_LIST_LIMIT = 100;

// How many notifications the status pill's Recent list keeps. Session state
// only — enough to recover a missed toast, small enough to never need paging.
const NOTIFICATION_LIMIT = 20;

// Page size for the Ask page's answered-questions list. GET /api/questions is
// paginated (limit/offset + unpaginated total) so the console can walk the whole
// history; the fast tier re-fetches whichever page the operator is on.
const QUESTIONS_PAGE_SIZE = 8;

// The one place the /questions query string is built, so the fast-tier poll and
// the pager/search fetches always agree on the page and the search filter.
function questionsRequestPath(page: number, search: string): string {
  const filter = search ? `&q=${encodeURIComponent(search)}` : "";
  return `/questions?limit=${QUESTIONS_PAGE_SIZE}&offset=${page * QUESTIONS_PAGE_SIZE}${filter}`;
}

// Response of GET /questions: one page plus the unfiltered backlog size (total)
// and the size of the set the search narrowed it to (matching).
interface QuestionsPageResponse {
  questions: QuestionLog[];
  total: number;
  matching: number;
}

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
  // Current page (0-based) of the answered-questions list, plus two unpaginated
  // counts from GET /questions: `total` is the whole live backlog (the sidebar
  // badge), `matching` is the set the active search narrows it to (what the
  // pager walks — equal to total when no search is active).
  const [questionsPage, setQuestionsPage] = useState(0);
  const [questionsTotal, setQuestionsTotal] = useState(0);
  const [questionsMatching, setQuestionsMatching] = useState(0);
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
  const [sourceMapEntries, setSourceMapEntries] = useState<SourceMapEntry[]>([]);
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
  // The notification feed behind the topbar status pill: newest first, capped
  // at NOTIFICATION_LIMIT. `toasts` is the transient overlay view of the same
  // entries — showMessage adds to both, a timeout (or manual dismiss) removes
  // from toasts only, so the feed keeps what the toast showed.
  const [notifications, setNotifications] = useState<UiNotification[]>([]);
  const [toasts, setToasts] = useState<UiNotification[]>([]);
  const jobsRef = useRef<JobView[]>([]);
  // The previous proposals page, kept so a refresh can anchor the selection to
  // a dropped proposal's nearest surviving neighbour (see anchorProposalSelection).
  const proposalsRef = useRef<Proposal[]>([]);
  const notificationIdRef = useRef(0);
  // Holds the AbortController for the in-flight refresh. The 4s poll and a manual
  // Refresh can overlap; aborting the previous request before starting a new one
  // (and ignoring a superseded controller's results) stops a slow stale response
  // from clobbering fresher state. Fast and slow tiers each get their own
  // controller since they now run on independent schedules.
  const refreshControllerRef = useRef<AbortController | undefined>(undefined);
  const slowRefreshControllerRef = useRef<AbortController | undefined>(undefined);
  // The answered-questions page and search term the next refresh should fetch.
  // Refs (mirroring the questionsPage/answeredSearch state) because refreshFast
  // is captured by interval timers whose closures would otherwise poll a stale
  // page or filter after the operator moves on.
  const questionsPageRef = useRef(0);
  const answeredSearchRef = useRef("");
  // Debounce timer for the search input, so a fast typist doesn't fire one
  // request per keystroke.
  const searchDebounceRef = useRef<number | undefined>(undefined);

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
    const sourceIds = (config?.knowledge?.sources ?? [])
      .map((source) => source.id)
      .filter(Boolean);
    if (sourceIds.length === 0) {
      setSourceMapEntries([]);
      return;
    }
    let cancelled = false;
    apiGet<SourceMapResponse>(`/source-map?sourceIds=${sourceIds.join(",")}`)
      .then((result) => {
        if (!cancelled) setSourceMapEntries(result.entries);
      })
      .catch(() => {
        if (!cancelled) setSourceMapEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [config?.knowledge?.sources]);

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

  function showMessage(text: string, tone: UiNotification["tone"] = "info") {
    const notification: UiNotification = {
      id: notificationIdRef.current++,
      text,
      tone,
      at: new Date().toISOString(),
      read: false
    };
    setNotifications((current) => [notification, ...current].slice(0, NOTIFICATION_LIMIT));
    setToasts((current) => [...current, notification]);
    // Same timings as the old inline banner. The toast is only the transient
    // view — the notification stays in the feed for the pill's Recent list.
    window.setTimeout(
      () => setToasts((current) => current.filter((toast) => toast.id !== notification.id)),
      tone === "danger" ? 10_000 : 5_000
    );
  }

  function dismissToast(id: number) {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }

  function dismissNotification(id: number) {
    setNotifications((current) => current.filter((notification) => notification.id !== id));
  }

  function clearNotifications() {
    setNotifications([]);
  }

  // Called when the status pill's popover opens; keeps identity stable when
  // nothing was unread so polling re-renders don't churn state.
  function markNotificationsRead() {
    setNotifications((current) =>
      current.some((notification) => !notification.read)
        ? current.map((notification) => (notification.read ? notification : { ...notification, read: true }))
        : current
    );
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

  async function acceptFailedJobs(jobIds: string[]) {    try {
      const results = await Promise.all(
        jobIds.map((jobId) => apiPost<{ job: JobView }>(`/jobs/${jobId}/accept-failure`, {}))
      );
      const selected = results.find((result) => result.job.id === selectedJobId);
      if (selected) setSelectedJob(selected.job);
      showMessage(`${jobIds.length} failed job${jobIds.length === 1 ? "" : "s"} accepted.`, "success");
      await refresh();
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    }
  }

  async function selectJob(jobId: string) {
    setSelectedJobId(jobId);    try {
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

  async function cancelJob(jobId: string) {    try {
      const result = await apiPost<{ job: JobView }>(`/jobs/${jobId}/cancel`, {});
      if (selectedJobId === jobId) {
        setSelectedJob(result.job);
      }
      showMessage("Job cancelled.", "success");
      await refresh();
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    }
  }

  async function retryJob(jobId: string) {    try {
      const result = await apiPost<{ job: JobView }>(`/jobs/${jobId}/retry`, {});
      if (selectedJobId === jobId) {
        setSelectedJob(result.job);
      }
      showMessage("Job re-queued for retry.", "success");
      await refresh();
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
  async function refreshFast(options: { silent?: boolean } = {}) {
    // Abort any fast refresh still in flight so its (now stale) response is
    // discarded and never overwrites the state this newer refresh is about to set.
    refreshControllerRef.current?.abort();
    const controller = new AbortController();
    refreshControllerRef.current = controller;
    const { signal } = controller;

    setRefreshing(true);
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
        apiGet<QuestionsPageResponse>(questionsRequestPath(questionsPageRef.current, answeredSearchRef.current), {
          signal
        }),
        apiGet<{ gaps: GapCandidate[] }>("/gaps/candidates?limit=8", { signal }),
        apiGet<{ clusters: SuggestedGapCluster[] }>("/gaps/clusters?limit=8", { signal }),
        apiGet<JobsResponse>("/jobs?limit=100", { signal }),
        apiGet<{ schedules: ScheduleView[] }>("/jobs/schedules", { signal }),
        apiGet<WorkersResponse>("/workers", { signal }),
        apiGet<{ proposals: Proposal[] }>(`/proposals?limit=${PROPOSALS_LIST_LIMIT}`, { signal }),
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
      setQuestionsTotal(questionsResult.total);
      setQuestionsMatching(questionsResult.matching);
      // If the matched set shrank under the operator (logs deleted, or a fresher
      // search applied) and their page no longer exists, snap back to the last
      // real page rather than showing an empty list with a dead pager.
      const lastQuestionsPage = Math.max(0, Math.ceil(questionsResult.matching / QUESTIONS_PAGE_SIZE) - 1);
      if (questionsPageRef.current > lastQuestionsPage) {
        void loadQuestionsPage(lastQuestionsPage);
      }
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
      // Anchor rather than snap: when the selected proposal dropped off the
      // active list (merged/rejected), keep the preview on its nearest
      // surviving neighbour so working a backlog doesn't jump back to the top.
      setSelectedProposalId((current) =>
        anchorProposalSelection(proposalsRef.current, proposalsResult.proposals, current)
      );
      proposalsRef.current = proposalsResult.proposals;
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
  async function refresh(options: { silent?: boolean } = {}) {
    await Promise.all([refreshFast(options), refreshSlow({ silent: options.silent })]);
  }

  // Pager for the Ask page's answered-questions list: fetches just the requested
  // page (within the active search, if any) rather than re-running the whole
  // fast tier. Subsequent fast-tier polls keep whichever page the operator lands
  // on fresh (via questionsPageRef/answeredSearchRef).
  async function loadQuestionsPage(page: number) {
    const next = Math.max(0, page);
    const search = answeredSearchRef.current;
    questionsPageRef.current = next;
    setQuestionsPage(next);
    try {
      const result = await apiGet<QuestionsPageResponse>(questionsRequestPath(next, search));
      // The operator paged or re-searched again (or a poll moved the page) while
      // this request was in flight — drop the stale response.
      if (questionsPageRef.current !== next || answeredSearchRef.current !== search) {
        return;
      }
      setQuestions(result.questions);
      setQuestionsTotal(result.total);
      setQuestionsMatching(result.matching);
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    }
  }

  // Search over the WHOLE question history, server-side — the pager then walks
  // the matches. The input stays responsive (state updates per keystroke) while
  // the fetch is debounced; every search starts back at the first page.
  function searchAnsweredQuestions(value: string) {
    setAnsweredSearch(value);
    answeredSearchRef.current = value.trim();
    questionsPageRef.current = 0;
    setQuestionsPage(0);
    window.clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = window.setTimeout(() => void loadQuestionsPage(0), 300);
  }

  // Shared by the Ask form and the "pick a flow" re-ask. `flow` is "auto" or a
  // configured flow id; the API rejects an unknown id with a 400.
  async function submitQuestion(questionText: string, flow: string) {
    setLoading(true);    try {
      const result = await apiPost<AskResponse>("/ask", { question: questionText, flow });
      setQuestion("");
      // A fresh question always lands at the top of the newest-first list; jump
      // back to the first page — and drop any active search, which would
      // otherwise hide the new question — so the operator sees it arrive.
      questionsPageRef.current = 0;
      setQuestionsPage(0);
      answeredSearchRef.current = "";
      setAnsweredSearch("");
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
      await refresh();
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

  async function sendFeedback(questionId: string, feedback: Feedback) {    try {
      const result = await apiPost<{ question: QuestionLog }>(`/questions/${questionId}/feedback`, { feedback });
      setQuestions((current) => current.map((item) => (item.id === questionId ? result.question : item)));
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    }
  }

  async function toggleKnowledgeGap(questionId: string, flagged: boolean) {    try {
      const result = flagged
        ? await apiPost<{ question: QuestionLog }>(`/questions/${questionId}/gap`, {})
        : await apiDelete<{ question: QuestionLog }>(`/questions/${questionId}/gap`);
      setQuestions((current) => current.map((item) => (item.id === questionId ? result.question : item)));
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    }
  }

  // Purge a logged question (e.g. one that carried sensitive info). `scrub` also
  // cleans the downstream clusters + unpublished proposals it seeded; published
  // proposals come back as warnings the operator must handle by hand. Requires
  // manage:admin — the API rejects an under-scoped caller with 403. Returns
  // whether the delete succeeded so the dialog knows to close.
  async function deleteQuestion(questionId: string, scrub: boolean): Promise<boolean> {
    try {
      const report = await apiDelete<QuestionDeletionReport>(
        `/questions/${questionId}${scrub ? "?scrub=true" : ""}`
      );
      // Drop it from the current page immediately; the next refresh reconciles the
      // pager (the fast tier already snaps back off an empty page).
      setQuestions((current) => current.filter((item) => item.id !== questionId));
      const warnings = report.warnings ?? [];
      if (warnings.length > 0) {
        const list = warnings
          .map((warning) => `“${warning.title}”${warning.pullRequestUrl ? ` (${warning.pullRequestUrl})` : ""}`)
          .join("; ");
        showMessage(
          `Question deleted, but ${warnings.length} published proposal${
            warnings.length === 1 ? "" : "s"
          } still contain its text and must be handled manually: ${list}`,
          "danger"
        );
      } else {
        showMessage(scrub ? "Question and its downstream drafts scrubbed." : "Question deleted.", "success");
      }
      await refresh();
      return true;
    } catch (error) {
      showMessage(errorMessage(error), "danger");
      return false;
    }
  }

  async function draftProposal(gap: GapCandidate) {
    setLoading(true);    try {
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
      await refresh();
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
    setLoading(true);    try {
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
      await refresh();
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    } finally {
      setLoading(false);
    }
  }

  async function updateProposalStatus(proposalId: string, status: Proposal["status"]) {
    setLoading(true);    try {
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
        await refresh();
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
    setLoading(true);    try {
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
      await refresh();
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    } finally {
      setLoading(false);
    }
  }

  async function rejectProposal(proposalId: string) {
    setLoading(true);    try {
      const result = await apiPost<{ proposal: Proposal }>(`/proposals/${proposalId}/reject`, {});
      setProposals((current) => current.map((proposal) => (proposal.id === proposalId ? result.proposal : proposal)));
      setSelectedProposalId(result.proposal.id);
      showMessage(
        "Proposal binned — the review branch was deleted and its gap cluster frozen so it is not re-proposed.",
        "success"
      );
      // Rejected proposals drop out of the active list; pull fresh state.
      await refresh();
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    } finally {
      setLoading(false);
    }
  }

  async function publishProposal(proposalId: string) {
    setLoading(true);    try {
      // Fire-and-forget enqueue (see runPublishProposal): no jump to the Jobs
      // section and no /jobs/:id/wait long-poll, so the shared `loading` flag
      // clears as soon as the job is queued instead of blocking the console for
      // up to the API's 25s wait deadline. The active-job 4s polling (plus
      // jobTransitionMessages) surfaces the publish outcome on this page.
      await runPublishProposal({ apiPost, showMessage, refresh }, proposalId);
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    } finally {
      setLoading(false);
    }
  }

  // One review action across many proposals via POST /proposals/bulk. The whole
  // batch produces exactly one summary message and one refresh, so mass-working
  // a backlog doesn't re-jolt the page per proposal the way the single-item
  // actions do.
  async function bulkProposalAction(action: BulkProposalAction, ids: string[]) {
    if (ids.length === 0) {
      return;
    }
    setLoading(true);    try {
      const { results } = await apiPost<{ results: BulkProposalResult[] }>("/proposals/bulk", { action, ids });
      const outcome = bulkOutcomeMessage(action, results);
      showMessage(outcome.text, outcome.tone);
      await refresh();
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    } finally {
      setLoading(false);
    }
  }

  async function saveScheduledTask(key: string, enabled: boolean, cron: string) {    try {
      const result = await apiPost<{ tasks: ScheduledTask[] }>(`/scheduled-tasks/${key}/settings`, { enabled, cron });
      setScheduledTasks(result.tasks);
      showMessage(enabled ? "Side-process schedule enabled." : "Side-process schedule disabled.", "success");
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    }
  }

  async function runScheduledTask(key: string) {
    setLoading(true);    try {
      const result = await apiPost<{ job: JobView; tasks: ScheduledTask[] }>(`/scheduled-tasks/${key}/run`, {});
      setScheduledTasks(result.tasks);
      const job = await waitForJob(result.job);
      showMessage(
        isActiveJob(job)
          ? "Side-process queued; it runs on the watcher in the background."
          : `Side-process ${job.state}.`,
        job.state === "failed" ? "danger" : "success"
      );
      await refresh();
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

    setIndexingRepo(true);    try {
      const summary = await apiPost<IndexRepositoryResponse>("/knowledge/repositories/index", {
        flowId: nextFlowId.trim()
      });
      showMessage(
        `Indexed ${summary.repository.name} with ${summary.documentCount} documents and ${summary.sectionCount} sections.`,
        "success"
      );
      await refresh();
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    } finally {
      setIndexingRepo(false);
    }
  }

  // Propose a seed plan for a flow: enqueue the source-grounded planning job.
  // Enqueue-only — the persisted plan lands via the job's completion handler, so
  // the panel polls listSeedPlans rather than waiting on the job here. `reused`
  // means an outline run for this flow was already in flight and its job id is
  // returned instead of double-planning.
  async function proposeSeedPlan(
    targetFlowId: string,
    notes: string
  ): Promise<{ jobId: string; reused: boolean } | undefined> {    try {
      const trimmedNotes = notes.trim();
      const outcome = await apiPost<{ ok: boolean; jobId: string; reused: boolean }>(
        `/flows/${encodeURIComponent(targetFlowId)}/outline`,
        { notes: trimmedNotes ? trimmedNotes : undefined }
      );
      showMessage(
        outcome.reused
          ? "Already planning this flow — the existing run's plan will appear here for review when ready."
          : "Planning — exploring the flow's sources; the plan will appear here for review when ready.",
        "info"
      );
      await refresh({ silent: true });
      return { jobId: outcome.jobId, reused: outcome.reused };
    } catch (error) {
      showMessage(errorMessage(error), "danger");
      return undefined;
    }
  }

  // The flow's persisted seed plans, newest first (undefined on failure, with
  // the error surfaced). The seed panel renders from these rows — never from a
  // raw outline job output.
  async function listSeedPlans(targetFlowId: string): Promise<SeedPlan[] | undefined> {
    try {
      const { plans } = await apiGet<{ plans: SeedPlan[] }>(
        `/flows/${encodeURIComponent(targetFlowId)}/seed-plans`
      );
      return plans;
    } catch (error) {
      showMessage(errorMessage(error), "danger");
      return undefined;
    }
  }

  // Save reviewer edits (charter/persona text, item fields, per-item status) to
  // a still-proposed plan.
  async function patchSeedPlan(planId: string, patch: SeedPlanPatchBody): Promise<SeedPlan | undefined> {    try {
      const { plan } = await apiPatch<{ plan: SeedPlan }>(`/seed-plans/${encodeURIComponent(planId)}`, patch);
      showMessage("Plan edits saved.", "success");
      return plan;
    } catch (error) {
      showMessage(errorMessage(error), "danger");
      return undefined;
    }
  }

  // Approve a plan: the API drafts one document per approved item straight into
  // the proposal → PR pipeline, carrying the plan's charter/persona.
  async function approveSeedPlan(planId: string): Promise<{ plan: SeedPlan; jobIds: string[] } | undefined> {    try {
      const outcome = await apiPost<{ plan: SeedPlan; jobIds: string[] }>(
        `/seed-plans/${encodeURIComponent(planId)}/approve`,
        {}
      );
      showMessage(
        `Approved — drafting ${outcome.jobIds.length} document${outcome.jobIds.length === 1 ? "" : "s"}; drafts will appear as proposals.`,
        "success"
      );
      await refresh();
      return outcome;
    } catch (error) {
      showMessage(errorMessage(error), "danger");
      return undefined;
    }
  }

  async function dismissSeedPlan(planId: string): Promise<SeedPlan | undefined> {    try {
      const { plan } = await apiPost<{ plan: SeedPlan }>(`/seed-plans/${encodeURIComponent(planId)}/dismiss`, {});
      showMessage("Plan dismissed. It will not be re-proposed until the flow's sources change.", "success");
      return plan;
    } catch (error) {
      showMessage(errorMessage(error), "danger");
      return undefined;
    }
  }

  // Revise a still-proposed plan by a natural-language instruction. Enqueue-only —
  // the reshaped plan lands in place; the panel polls listSeedPlans and re-hydrates
  // the same plan when it updates. The revision reshapes the plan text without
  // re-reading the flow's sources.
  async function reviseSeedPlan(planId: string, instruction: string): Promise<{ jobId: string } | undefined> {
    try {
      const outcome = await apiPost<{ jobId: string }>(
        `/seed-plans/${encodeURIComponent(planId)}/revise`,
        { instruction }
      );
      showMessage("Revising the plan — it will update here when the revision lands.", "info");
      return outcome;
    } catch (error) {
      showMessage(errorMessage(error), "danger");
      return undefined;
    }
  }

  return {
    health,
    stats,
    questions,
    questionsPage,
    questionsTotal,
    questionsMatching,
    questionsPageCount: Math.max(1, Math.ceil(questionsMatching / QUESTIONS_PAGE_SIZE)),
    loadQuestionsPage,
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
    sourceMapEntries,
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
    notifications,
    toasts,
    latestJob,
    attentionNotices,
    setConfig,
    setSelectedProposalId,
    setSelectedDocumentId,
    setFlowId,
    setAskFlow,
    setAnsweredSearch: searchAnsweredQuestions,
    setQuestion,
    showMessage,
    dismissToast,
    dismissNotification,
    clearNotifications,
    markNotificationsRead,
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
    deleteQuestion,
    draftProposal,
    draftCluster,
    updateProposalStatus,
    mergeProposal,
    rejectProposal,
    publishProposal,
    bulkProposalAction,
    saveScheduledTask,
    runScheduledTask,
    indexRepository,
    proposeSeedPlan,
    listSeedPlans,
    patchSeedPlan,
    approveSeedPlan,
    dismissSeedPlan,
    reviseSeedPlan
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
