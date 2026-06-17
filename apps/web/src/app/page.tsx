"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  AiJob,
  AskResponse,
  ConsoleSection,
  CrunchRun,
  CrunchSettings,
  Feedback,
  GapCandidate,
  Health,
  IndexRepositoryResponse,
  KnowledgeDocument,
  KnowledgeStats,
  Proposal,
  QuestionLog,
  RepositoryRef,
  RuntimeConfig,
  ScheduledTask,
  SuggestedGapCluster,
  UiMessage
} from "../lib/types.js";
import { apiDelete, apiGet, apiPost, errorMessage, resolveApiUrl } from "../lib/api.js";
import { extractModelInfo, knowledgeFlows } from "../lib/config.js";
import {
  buildAttentionNotices,
  formatJobType,
  isActiveJob,
  jobTransitionMessages,
  sectionSubtitle,
  sectionTitle
} from "../lib/console.js";
import { AttentionPanel, NavButton } from "../components/common.js";
import { AskPanel } from "../components/AskPanel.js";
import { AnsweredPanel } from "../components/AnsweredPanel.js";
import { KnowledgeBrowser, RepositoryContextPanel, RepositoryPanel, UploadPanel } from "../components/KnowledgePanel.js";
import { GapClusterPanel, GapPanel } from "../components/GapsPanel.js";
import { JobsPanel } from "../components/JobsPanel.js";
import { ProposalPanel } from "../components/ProposalsPanel.js";
import { CrunchPanel } from "../components/CrunchPanel.js";
import { DataFlowPanel } from "../components/DataFlowPanel.js";
import { ConfigPanel } from "../components/ConfigPanel.js";

export default function HomePage() {
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
  const [config, setConfig] = useState<RuntimeConfig | undefined>();
  const [selectedProposalId, setSelectedProposalId] = useState<string | undefined>();
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | undefined>();
  const [activeSection, setActiveSection] = useState<ConsoleSection>("ask");
  const [expandedQuestionIds, setExpandedQuestionIds] = useState<string[]>([]);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AskResponse | undefined>();
  const [answeredSearch, setAnsweredSearch] = useState("");
  const [flowId, setFlowId] = useState("cats");
  const [uploadPath, setUploadPath] = useState("uploaded/cats-note.md");
  const [uploadContent, setUploadContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [indexingRepo, setIndexingRepo] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | undefined>();
  const [message, setMessage] = useState<UiMessage | undefined>();
  const jobsRef = useRef<AiJob[]>([]);
  const messageIdRef = useRef(0);

  const latestJob = useMemo(
    () => [...jobs].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0],
    [jobs]
  );
  const attentionNotices = useMemo(
    () => buildAttentionNotices({ config, health, jobs, openSection, stats }),
    [config, health, jobs, stats]
  );
  const selectedProposal = proposals.find((proposal) => proposal.id === selectedProposalId) ?? proposals[0];
  const selectedDocument = documents.find((document) => document.id === selectedDocumentId) ?? documents[0];

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    const configuredFlowIds = knowledgeFlows(config).map((flow) => flow.id);
    if (configuredFlowIds.length > 0 && !configuredFlowIds.includes(flowId)) {
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
  }, [answer?.job?.id, answer?.job?.status, answer?.mode, answer?.result, jobs, crunchRuns]);

  function showMessage(text: string, tone: UiMessage["tone"] = "info") {
    setMessage({ id: messageIdRef.current++, text, tone });
  }

  function clearMessage() {
    setMessage(undefined);
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
    setRefreshing(true);
    if (!options.silent && !options.preserveMessage) {
      clearMessage();
    }
    try {
      const [healthResult, statsResult, repositoriesResult, documentsResult, questionsResult, gapsResult, clustersResult, jobsResult, proposalsResult, crunchRunsResult, crunchSettingsResult, scheduledTasksResult, configResult] = await Promise.all([
        apiGet<Health>("/health"),
        apiGet<KnowledgeStats>("/knowledge/stats"),
        apiGet<{ repositories: RepositoryRef[] }>("/repositories"),
        apiGet<{ documents: KnowledgeDocument[] }>("/documents"),
        apiGet<{ questions: QuestionLog[] }>("/questions?limit=8"),
        apiGet<{ gaps: GapCandidate[] }>("/gaps/candidates?limit=8"),
        apiGet<{ clusters: SuggestedGapCluster[] }>("/gaps/clusters?limit=8"),
        apiGet<{ jobs: AiJob[] }>("/ai-jobs"),
        apiGet<{ proposals: Proposal[] }>("/proposals?limit=8"),
        apiGet<{ runs: CrunchRun[] }>("/crunch/runs?limit=12"),
        apiGet<{ settings: CrunchSettings[] }>("/crunch/settings"),
        apiGet<{ tasks: ScheduledTask[] }>("/scheduled-tasks"),
        apiGet<RuntimeConfig>("/config")
      ]);

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
      setConfig(configResult);
      setSelectedProposalId((current) => current ?? proposalsResult.proposals[0]?.id);
      setSelectedDocumentId((current) =>
        current && documentsResult.documents.some((document) => document.id === current)
          ? current
          : documentsResult.documents[0]?.id
      );
      setLastRefreshedAt(new Date().toISOString());

      if (answer?.questionId) {
        const result = await apiGet<{ question: QuestionLog }>(`/questions/${answer.questionId}`);
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
      if (!options.silent) {
        showMessage(errorMessage(error), "danger");
      }
    } finally {
      setRefreshing(false);
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
        flowId
      });
      if (result.proposal) {
        setSelectedProposalId(result.proposal.id);
        setActiveSection("proposals");
      } else {
        setActiveSection("jobs");
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

  async function draftCluster(summaries: string[]) {
    if (summaries.length === 0) {
      return;
    }
    setLoading(true);
    clearMessage();
    try {
      const result = await apiPost<{ job?: AiJob; proposal?: Proposal }>("/proposals/from-gaps", {
        summaries,
        flowId
      });
      if (result.proposal) {
        setSelectedProposalId(result.proposal.id);
        setActiveSection("proposals");
      } else {
        setActiveSection("jobs");
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
      const result = await apiPost<{ proposal: Proposal; resolvedGapCount?: number; reindexed?: boolean }>(
        `/proposals/${proposalId}/status`,
        { status }
      );
      setProposals((current) => current.map((proposal) => (proposal.id === proposalId ? result.proposal : proposal)));
      setSelectedProposalId(result.proposal.id);
      if (status === "merged") {
        const gapPart = result.resolvedGapCount
          ? `${result.resolvedGapCount} gap${result.resolvedGapCount === 1 ? "" : "s"} resolved`
          : "no open gaps to resolve";
        const indexPart = result.reindexed ? "knowledge base re-indexed" : "re-index skipped";
        showMessage(`Proposal merged — ${gapPart}; ${indexPart}.`, "success");
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
      showMessage("Side-process run complete.", "success");
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

  async function uploadMarkdown(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!uploadPath.trim() || !uploadContent.trim()) {
      return;
    }

    setUploading(true);
    clearMessage();
    try {
      const summary = await apiPost<{ documentCount: number; sectionCount: number }>("/documents/upload", {
        repositoryId: "console-upload",
        name: "Console Upload",
        documents: [
          {
            path: uploadPath.trim(),
            content: uploadContent
          }
        ]
      });
      showMessage(`Indexed ${summary.documentCount} document with ${summary.sectionCount} sections.`, "success");
      setUploadContent("");
      await refresh({ preserveMessage: true });
    } catch (error) {
      showMessage(errorMessage(error), "danger");
    } finally {
      setUploading(false);
    }
  }

  async function indexRepository(nextFlowId = flowId) {
    if (!nextFlowId.trim()) {
      return;
    }

    setIndexingRepo(true);
    clearMessage();
    try {
      const summary = await apiPost<IndexRepositoryResponse>("/repositories/index", {
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

  async function useDroppedFiles(files: FileList | null) {
    const file = files?.[0];
    if (!file) {
      return;
    }

    setUploadPath(file.name.toLowerCase().endsWith(".md") ? file.name : `${file.name}.md`);
    setUploadContent(await file.text());
  }

  function openSection(section: ConsoleSection) {
    setActiveSection(section);
  }

  return (
    <div className="appShell">
      <aside className="sidebar">
        <div className="brand">
          <img className="brandLogo" src="/magpie.jpeg" alt="" aria-hidden="true" width={40} height={40} />
          <div className="brandText">
            <span>Markdown Magpie</span>
            <strong>Knowledge Console</strong>
          </div>
        </div>
        <nav className="sideNav" aria-label="Console sections">
          <NavButton active={activeSection === "ask"} glyph="Q" label="Ask" onClick={() => openSection("ask")} />
          <NavButton active={activeSection === "answered"} count={questions.length} glyph="A" label="Answered" onClick={() => openSection("answered")} />
          <NavButton active={activeSection === "knowledge"} count={stats.sectionCount} glyph="K" label="Knowledge" onClick={() => openSection("knowledge")} />
          <NavButton active={activeSection === "gaps"} count={gaps.length} glyph="G" label="Gaps" onClick={() => openSection("gaps")} />
          <NavButton active={activeSection === "jobs"} count={jobs.length} glyph="J" label="Jobs" onClick={() => openSection("jobs")} />
          <NavButton active={activeSection === "proposals"} count={proposals.length} glyph="P" label="Proposals" onClick={() => openSection("proposals")} />
          <NavButton active={activeSection === "crunch"} count={crunchRuns.length} glyph="Cr" label="Crunch" onClick={() => openSection("crunch")} />
          <NavButton active={activeSection === "dataflow"} glyph="D" label="Data Flow" onClick={() => openSection("dataflow")} />
          <NavButton active={activeSection === "config"} glyph="C" label="Config" onClick={() => openSection("config")} />
        </nav>
        <div className="sideStatus">
          <div className="statusLine">
            <span>API</span>
            <span>
              <span className={health?.ok ? "dot" : "dot offline"} />
              {health?.ok ? "Online" : "Offline"}
            </span>
          </div>
          <div className="statusLine">
            <span>Documents</span>
            <span>{stats.documentCount}</span>
          </div>
          <div className="statusLine">
            <span>Sections</span>
            <span>{stats.sectionCount}</span>
          </div>
          <div className="statusLine">
            <span>Latest Job</span>
            <span>
              {latestJob ? <span className={latestJob.status === "failed" ? "dot offline" : "dot"} /> : null}
              {latestJob ? latestJob.status : "None"}
            </span>
          </div>
          <div className="statusLine">
            <span>Mode</span>
            <span>{config?.aiRuntime.executionMode ?? "direct"}</span>
          </div>
          {(() => {
            const modelInfo = extractModelInfo(config);
            return (
              <>
                {modelInfo.chatModel && (
                  <div className="statusLine">
                    <span>Chat</span>
                    <span title={modelInfo.chatHost || undefined}>
                      {modelInfo.chatModel}
                      {modelInfo.chatHost && ` (${modelInfo.chatHost})`}
                    </span>
                  </div>
                )}
                {modelInfo.embeddingModel && (
                  <div className="statusLine">
                    <span>Embedding</span>
                    <span title={modelInfo.embeddingHost || undefined}>
                      {modelInfo.embeddingModel}
                      {modelInfo.embeddingHost && ` (${modelInfo.embeddingHost})`}
                    </span>
                  </div>
                )}
              </>
            );
          })()}
          <div className="statusLine">
            <span>Retrieval</span>
            <span title={config?.retrieval.reason}>
              {config?.retrieval.mode === "hybrid" ? "Hybrid (semantic + keyword)" : "Keyword only"}
            </span>
          </div>
          <div className="statusLine">
            <span>Updated</span>
            <span>{lastRefreshedAt ? new Date(lastRefreshedAt).toLocaleTimeString() : "Never"}</span>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <p className="eyebrow">Markdown Magpie</p>
            <h1>{sectionTitle(activeSection)}</h1>
            <p>{sectionSubtitle(activeSection)}</p>
          </div>
          <div className="topActions">
            <span className="refreshTime" aria-live="polite">
              {lastRefreshedAt ? `Updated ${new Date(lastRefreshedAt).toLocaleTimeString()}` : "Not refreshed yet"}
            </span>
            <button className="button secondary" disabled={refreshing} onClick={() => void refresh()} type="button">
              {refreshing ? "Refreshing" : "Refresh"}
            </button>
          </div>
        </header>

        {message ? (
          <div className={`alert ${message.tone}`} role="status" aria-live="polite">
            {message.text}
          </div>
        ) : null}
        {attentionNotices.length ? <AttentionPanel notices={attentionNotices} /> : null}

        {activeSection === "ask" ? (
          <section className="workbench singlePane">
            <div className="surface">
              <div className="surfaceHeader">
                <h2>Ask a Question</h2>
              </div>
              <div className="surfaceBody">
                <AskPanel
                  answer={answer}
                  loading={loading}
                  onAsk={ask}
                  question={question}
                  setQuestion={setQuestion}
                />
              </div>
            </div>
          </section>
        ) : null}

        {activeSection === "answered" ? (
          <section className="workbench singlePane">
            <div className="surface">
              <div className="surfaceHeader">
                <h2>Answered Questions</h2>
              </div>
              <div className="surfaceBody">
                <form className="inlineForm" onSubmit={(e) => e.preventDefault()}>
                  <input
                    onChange={(event) => setAnsweredSearch(event.target.value)}
                    placeholder="Search answered questions..."
                    type="search"
                    value={answeredSearch}
                  />
                </form>
                <AnsweredPanel
                  expandedQuestionIds={expandedQuestionIds}
                  onFeedback={sendFeedback}
                  onToggleGap={toggleKnowledgeGap}
                  questions={questions.filter(q =>
                    answeredSearch.trim() === '' ||
                    q.question.toLowerCase().includes(answeredSearch.toLowerCase())
                  )}
                  toggleCitations={(questionId) =>
                    setExpandedQuestionIds((current) =>
                      current.includes(questionId)
                        ? current.filter((id) => id !== questionId)
                        : [...current, questionId]
                    )
                  }
                />
              </div>
            </div>
          </section>
        ) : null}

        {activeSection === "knowledge" ? (
          <section className="knowledgePage">
            <RepositoryContextPanel repositories={repositories} />
            <div className="surface">
              <div className="surfaceHeader">
                <h2>Knowledge Base</h2>
        <span className="pill" title="Indexed Markdown documents">
          {documents.length} docs
        </span>
              </div>
              <div className="surfaceBody">
                <KnowledgeBrowser
                  documents={documents}
                  selectedDocument={selectedDocument}
                  setSelectedDocumentId={setSelectedDocumentId}
                />
              </div>
            </div>
            <div className="surface">
              <div className="surfaceHeader">
                <h2>Configured Knowledge Bases</h2>
                <span className="pill" title="Index a local Markdown repository or folder">
                  Configured
                </span>
              </div>
              <div className="surfaceBody">
                <RepositoryPanel
                  destinations={config?.knowledge.destinations ?? config?.knowledge.repositories ?? []}
                  flows={knowledgeFlows(config)}
                  indexing={indexingRepo}
                  onIndex={indexRepository}
                  selectedFlowId={flowId}
                  setSelectedFlowId={setFlowId}
                  sources={config?.knowledge.sources ?? []}
                />
              </div>
            </div>
            <div className="surface">
              <div className="surfaceHeader">
                <h2>Add Markdown</h2>
                <span className="pill" title="Add this Markdown to the searchable index">
                  Index
                </span>
              </div>
              <div className="surfaceBody">
                <UploadPanel
                  onDropFiles={useDroppedFiles}
                  onUpload={uploadMarkdown}
                  setUploadContent={setUploadContent}
                  setUploadPath={setUploadPath}
                  uploadContent={uploadContent}
                  uploading={uploading}
                  uploadPath={uploadPath}
                />
              </div>
            </div>
          </section>
        ) : null}

        {activeSection === "gaps" ? (
          <section className="workbench singlePane">
            <GapClusterPanel
              clusters={gapClusters}
              gaps={gaps}
              draftCluster={draftCluster}
              loading={loading}
            />
            <GapPanel draftProposal={draftProposal} gaps={gaps} loading={loading} />
          </section>
        ) : null}

        {activeSection === "jobs" ? (
          <section className="fullWorkbench">
            <JobsPanel jobs={jobs} />
          </section>
        ) : null}

        {activeSection === "proposals" ? (
          <section className="fullWorkbench">
            <ProposalPanel
              loading={loading}
              publishProposal={publishProposal}
              proposals={proposals}
              selectedProposal={selectedProposal}
              setSelectedProposalId={setSelectedProposalId}
              updateProposalStatus={updateProposalStatus}
            />
          </section>
        ) : null}

        {activeSection === "crunch" ? (
          <section className="fullWorkbench">
            <CrunchPanel
              flows={knowledgeFlows(config)}
              loading={loading}
              onPublish={publishCrunchRun}
              onRun={runCrunch}
              onRunTask={runScheduledTask}
              onSaveSchedule={saveCrunchSchedule}
              onSaveTask={saveScheduledTask}
              runs={crunchRuns}
              scheduledTasks={scheduledTasks}
              settings={crunchSettings}
            />
          </section>
        ) : null}

        {activeSection === "dataflow" ? (
          <section className="workbench singlePane">
            <DataFlowPanel config={config} />
          </section>
        ) : null}

        {activeSection === "config" ? (
          <section className="fullWorkbench">
            <ConfigPanel
              apiBaseUrl={resolveApiUrl("")}
              config={config}
              onConfigChange={setConfig}
              onMessage={(text, tone) => (text ? showMessage(text, tone) : clearMessage())}
            />
          </section>
        ) : null}
      </main>
    </div>
  );
}
