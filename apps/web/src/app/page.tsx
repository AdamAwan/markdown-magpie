"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

const configuredApiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;

declare global {
  interface Window {
    __MAGPIE_CONFIG__?: {
      apiBaseUrl?: string;
    };
  }
}

function resolveApiBaseUrl(): string {
  if (configuredApiBaseUrl) {
    return configuredApiBaseUrl.replace(/\/+$/, "");
  }

  if (typeof window !== "undefined" && window.__MAGPIE_CONFIG__?.apiBaseUrl) {
    return window.__MAGPIE_CONFIG__.apiBaseUrl.replace(/\/+$/, "");
  }

  if (typeof window !== "undefined") {
    return `${window.location.protocol}//${window.location.hostname}:4000`;
  }

  return "http://localhost:4000";
}

type Confidence = "high" | "medium" | "low" | "unknown";
type Feedback = "helpful" | "unhelpful";
type ConsoleSection = "ask" | "knowledge" | "gaps" | "jobs" | "proposals" | "config";
type WorkspaceTab = "ask" | "search" | "recent";
type AiExecutionMode = "direct" | "queue";
type AiProviderName = "mock" | "openai-compatible" | "azure-openai" | "codex" | "claude";

interface Health {
  ok: boolean;
  service: string;
}

interface KnowledgeStats {
  repositoryCount: number;
  documentCount: number;
  sectionCount: number;
}

interface RuntimeConfig {
  api: Record<string, string | number | null>;
  stores: Record<string, string | number | null>;
  knowledge: Record<string, string | number | null>;
  providers: Record<string, unknown>;
  aiRuntime: {
    executionMode: AiExecutionMode;
    provider: AiProviderName;
    executionModes: AiExecutionMode[];
    directProviders: AiProviderName[];
    queueProviders: AiProviderName[];
    providers: Array<{
      name: AiProviderName;
      label: string;
      supportsDirect: boolean;
      supportsQueue: boolean;
    }>;
  };
  watcher: Record<string, string | number | null>;
}

interface KnowledgeDocument {
  id: string;
  repositoryId: string;
  path: string;
  commitSha?: string;
  metadata: {
    title: string;
    owner?: string;
    status: string;
    tags: string[];
  };
  content: string;
}

interface RepositoryRef {
  id: string;
  name: string;
  remoteUrl?: string;
  defaultBranch: string;
  localPath: string;
  provider: "local" | "github" | "gitlab" | "azure-devops";
  git?: GitRepositoryContext;
}

interface GitRepositoryContext {
  scope: "repository-root" | "subdirectory" | "not-git";
  indexedPath: string;
  workTreeRoot?: string;
  relativePathFromRoot?: string;
  currentBranch?: string;
  defaultBranch?: string;
  headSha?: string;
  remoteUrl?: string;
  hasUncommittedChanges?: boolean;
}

interface Citation {
  sectionId: string;
  path: string;
  heading: string;
  anchor: string;
  excerpt: string;
}

interface AnswerResult {
  answer: string;
  confidence: Confidence;
  citations: Citation[];
  gap?: {
    summary: string;
    question: string;
  };
}

interface QuestionLog {
  id: string;
  question: string;
  executionMode: string;
  chatProvider: string;
  confidence: Confidence;
  retrievedSectionIds: string[];
  askedAt: string;
  answer?: AnswerResult;
  feedback?: Feedback;
  manualGap?: boolean;
}

interface GapCandidate {
  summary: string;
  questionIds: string[];
  count: number;
  latestAskedAt: string;
  confidence: Confidence;
}

interface AiJob {
  id: string;
  type: string;
  status: string;
  claimedBy?: string;
  createdAt: string;
  updatedAt: string;
}

interface ConsoleNotice {
  id: string;
  title: string;
  body: string;
  tone: "warning" | "info" | "danger";
  actionLabel?: string;
  action?: () => void;
}

interface UiMessage {
  id: number;
  text: string;
  tone: "info" | "success" | "danger";
}

type JobTransitionMessage = Pick<UiMessage, "text" | "tone">;

interface Proposal {
  id: string;
  title: string;
  status: "draft" | "ready" | "branch-pushed" | "pr-opened" | "merged" | "rejected";
  targetPath: string;
  markdown: string;
  gapSummary?: string;
  triggeringQuestionIds?: string[];
  rationale?: string;
  jobId?: string;
  publication?: ProposalPublication;
  createdAt: string;
}

interface ProposalPublication {
  provider: "local-git";
  branchName: string;
  commitSha: string;
  remoteUrl?: string;
  pullRequestUrl?: string;
  publishedAt: string;
}

interface SearchSection {
  id: string;
  path: string;
  heading: string;
  anchor: string;
  content: string;
}

interface AskResponse {
  mode: string;
  questionId: string;
  result?: AnswerResult;
  job?: AiJob;
}

interface IndexRepositoryResponse {
  documentCount: number;
  sectionCount: number;
  repository: {
    id: string;
    name: string;
    localPath: string;
  };
}

export default function HomePage() {
  const [health, setHealth] = useState<Health | undefined>();
  const [stats, setStats] = useState<KnowledgeStats>({ repositoryCount: 0, documentCount: 0, sectionCount: 0 });
  const [questions, setQuestions] = useState<QuestionLog[]>([]);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [repositories, setRepositories] = useState<RepositoryRef[]>([]);
  const [gaps, setGaps] = useState<GapCandidate[]>([]);
  const [jobs, setJobs] = useState<AiJob[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [config, setConfig] = useState<RuntimeConfig | undefined>();
  const [selectedProposalId, setSelectedProposalId] = useState<string | undefined>();
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | undefined>();
  const [activeSection, setActiveSection] = useState<ConsoleSection>("ask");
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("ask");
  const [expandedQuestionIds, setExpandedQuestionIds] = useState<string[]>([]);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AskResponse | undefined>();
  const [query, setQuery] = useState("");
  const [sections, setSections] = useState<SearchSection[]>([]);
  const [repoPath, setRepoPath] = useState("knowledge-bases/cats");
  const [repoId, setRepoId] = useState("cats");
  const [repoName, setRepoName] = useState("Cats Knowledge Base");
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
    if (!message) {
      return;
    }

    const timeout = window.setTimeout(() => setMessage(undefined), message.tone === "danger" ? 10_000 : 5_000);
    return () => window.clearTimeout(timeout);
  }, [message]);

  useEffect(() => {
    const hasActiveWork =
      jobs.some(isActiveJob) ||
      (answer?.job ? isActiveJob(answer.job) : false) ||
      (answer?.mode === "queue" && !answer.result);

    if (!hasActiveWork) {
      return;
    }

    const interval = window.setInterval(() => void refresh({ silent: true }), 4_000);
    return () => window.clearInterval(interval);
  }, [answer?.job?.id, answer?.job?.status, answer?.mode, answer?.result, jobs]);

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
      const [healthResult, statsResult, repositoriesResult, documentsResult, questionsResult, gapsResult, jobsResult, proposalsResult, configResult] = await Promise.all([
        apiGet<Health>("/health"),
        apiGet<KnowledgeStats>("/knowledge/stats"),
        apiGet<{ repositories: RepositoryRef[] }>("/repositories"),
        apiGet<{ documents: KnowledgeDocument[] }>("/documents"),
        apiGet<{ questions: QuestionLog[] }>("/questions?limit=8"),
        apiGet<{ gaps: GapCandidate[] }>("/gaps/candidates?limit=8"),
        apiGet<{ jobs: AiJob[] }>("/ai-jobs"),
        apiGet<{ proposals: Proposal[] }>("/proposals?limit=8"),
        apiGet<RuntimeConfig>("/config")
      ]);

      setHealth(healthResult);
      setStats(statsResult);
      setRepositories(repositoriesResult.repositories);
      setDocuments(documentsResult.documents);
      setQuestions(questionsResult.questions);
      setGaps(gapsResult.gaps);
      applyJobs(jobsResult.jobs, jobsRef.current.length > 0);
      setProposals(proposalsResult.proposals);
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

      if (query.trim()) {
        const result = await apiGet<{ sections: SearchSection[] }>(`/search?q=${encodeURIComponent(query.trim())}&limit=6`);
        setSections(result.sections);
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

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!query.trim()) {
      return;
    }

    setLoading(true);
    clearMessage();
    try {
      const result = await apiGet<{ sections: SearchSection[] }>(`/search?q=${encodeURIComponent(query.trim())}&limit=6`);
      setSections(result.sections);
      setWorkspaceTab("search");
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
        targetPath: "knowledge-bases/cats/proposed-gap.md"
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
      const result = await apiPost<{ proposal: Proposal }>(`/proposals/${proposalId}/status`, { status });
      setProposals((current) => current.map((proposal) => (proposal.id === proposalId ? result.proposal : proposal)));
      setSelectedProposalId(result.proposal.id);
      showMessage(status === "ready" ? "Proposal marked ready for PR workflow." : "Proposal rejected.", "success");
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
      const result = await apiPost<{ proposal: Proposal }>(`/proposals/${proposalId}/publish`, {});
      setProposals((current) => current.map((proposal) => (proposal.id === proposalId ? result.proposal : proposal)));
      setSelectedProposalId(result.proposal.id);
      showMessage(`Published ${result.proposal.publication?.branchName ?? "proposal branch"}.`, "success");
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

  async function indexRepository(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!repoPath.trim()) {
      return;
    }

    setIndexingRepo(true);
    clearMessage();
    try {
      const summary = await apiPost<IndexRepositoryResponse>("/repositories/index", {
        localPath: repoPath.trim(),
        repositoryId: repoId.trim() || undefined,
        name: repoName.trim() || undefined
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
    if (section === "ask") {
      setWorkspaceTab("ask");
    }
  }

  return (
    <div className="appShell">
      <aside className="sidebar">
        <div className="brand">
          <span>Markdown Magpie</span>
          <strong>Knowledge Console</strong>
        </div>
        <nav className="sideNav" aria-label="Console sections">
          <NavButton active={activeSection === "ask"} count={questions.length} glyph="Q" label="Ask" onClick={() => openSection("ask")} />
          <NavButton active={activeSection === "knowledge"} count={stats.sectionCount} glyph="K" label="Knowledge" onClick={() => openSection("knowledge")} />
          <NavButton active={activeSection === "gaps"} count={gaps.length} glyph="G" label="Gaps" onClick={() => openSection("gaps")} />
          <NavButton active={activeSection === "jobs"} count={jobs.length} glyph="J" label="Jobs" onClick={() => openSection("jobs")} />
          <NavButton active={activeSection === "proposals"} count={proposals.length} glyph="P" label="Proposals" onClick={() => openSection("proposals")} />
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
            <span>Provider</span>
            <span>{config?.aiRuntime.provider ?? "mock"}</span>
          </div>
          <div className="statusLine">
            <span>Mode</span>
            <span>{config?.aiRuntime.executionMode ?? "direct"}</span>
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

        <section className="summary" aria-label="System summary">
          <Metric label="API" value={health?.ok ? "Online" : "Offline"} tone={health?.ok ? "good" : "bad"} />
          <Metric label="Documents" value={stats.documentCount.toString()} />
          <Metric label="Sections" value={stats.sectionCount.toString()} />
          <Metric label="Latest Job" value={latestJob ? latestJob.status : "None"} tone={latestJob?.status === "failed" ? "bad" : "neutral"} />
        </section>

        {activeSection === "ask" ? (
          <section className="workbench singlePane">
            <div className="surface">
              <div className="surfaceHeader">
                <h2>Workspace</h2>
                <div className="tabs" role="tablist" aria-label="Workspace views">
                  <TabButton active={workspaceTab === "ask"} label="Ask" onClick={() => setWorkspaceTab("ask")} />
                  <TabButton active={workspaceTab === "search"} label="Search" onClick={() => setWorkspaceTab("search")} />
                  <TabButton active={workspaceTab === "recent"} label="Recent" onClick={() => setWorkspaceTab("recent")} />
                </div>
              </div>
              <div className="surfaceBody">
                {workspaceTab === "ask" ? (
                  <AskPanel
                    answer={answer}
                    loading={loading}
                    onAsk={ask}
                    question={question}
                    setQuestion={setQuestion}
                  />
                ) : null}
                {workspaceTab === "search" ? (
                  <SearchPanel
                    loading={loading}
                    query={query}
                    sections={sections}
                    search={search}
                    setQuery={setQuery}
                  />
                ) : null}
                {workspaceTab === "recent" ? (
                  <RecentQuestions
                    expandedQuestionIds={expandedQuestionIds}
                    onFeedback={sendFeedback}
                    onToggleGap={toggleKnowledgeGap}
                    questions={questions}
                    toggleCitations={(questionId) =>
                      setExpandedQuestionIds((current) =>
                        current.includes(questionId)
                          ? current.filter((id) => id !== questionId)
                          : [...current, questionId]
                      )
                    }
                  />
                ) : null}
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
                <h2>Add Repository</h2>
                <span className="pill" title="Index a local Markdown repository or folder">
                  Repository
                </span>
              </div>
              <div className="surfaceBody">
                <RepositoryPanel
                  indexing={indexingRepo}
                  onIndex={indexRepository}
                  repoId={repoId}
                  repoName={repoName}
                  repoPath={repoPath}
                  setRepoId={setRepoId}
                  setRepoName={setRepoName}
                  setRepoPath={setRepoPath}
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
          <section className="workbench">
            <GapPanel draftProposal={draftProposal} gaps={gaps} loading={loading} />
            <ProposalLinks proposals={proposals} openProposal={(proposalId) => {
              setSelectedProposalId(proposalId);
              setActiveSection("proposals");
            }} />
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

        {activeSection === "config" ? (
          <section className="fullWorkbench">
            <ConfigPanel
              apiBaseUrl={resolveApiBaseUrl()}
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

function AttentionPanel({ notices }: { notices: ConsoleNotice[] }) {
  return (
    <section className="attentionPanel" aria-label="System notices">
      {notices.map((notice) => (
        <article className={`attentionNotice ${notice.tone}`} key={notice.id}>
          <div>
            <h2>{notice.title}</h2>
            <p>{notice.body}</p>
          </div>
          {notice.action && notice.actionLabel ? (
            <button className="chip" onClick={notice.action} type="button">
              {notice.actionLabel}
            </button>
          ) : null}
        </article>
      ))}
    </section>
  );
}

function AskPanel({
  answer,
  loading,
  onAsk,
  question,
  setQuestion
}: {
  answer?: AskResponse;
  loading: boolean;
  onAsk: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  question: string;
  setQuestion: (value: string) => void;
}) {
  return (
    <>
      <form className="questionForm" onSubmit={onAsk}>
        <label className="field">
          <span>Question</span>
          <textarea
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="What are urgent cat warning signs?"
            rows={4}
            value={question}
          />
        </label>
        <button className="button" disabled={loading || !question.trim()} type="submit">
          Ask
        </button>
      </form>
      {answer ? (
        <div className="answerBlock">
          <div className="resultHeader">
            <span
              className={`status ${answer.result?.confidence ?? "unknown"}`}
              title={answer.result ? `Answer confidence: ${answer.result.confidence}` : "Answer is queued"}
            >
              {answer.result?.confidence ?? "queued"}
            </span>
            <code>{answer.questionId}</code>
          </div>
          <p>{answer.result?.answer ?? `Queued as ${answer.job?.type ?? "AI job"}`}</p>
          {answer.result?.citations.length ? (
            <div className="citationStack">
              {answer.result.citations.map((citation) => (
                <CitationRow citation={citation} key={citation.sectionId} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function SearchPanel({
  loading,
  query,
  search,
  sections,
  setQuery
}: {
  loading: boolean;
  query: string;
  search: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  sections: SearchSection[];
  setQuery: (value: string) => void;
}) {
  return (
    <>
      <form className="inlineForm" onSubmit={search}>
        <input onChange={(event) => setQuery(event.target.value)} placeholder="warning signs" type="search" value={query} />
        <button className="button" disabled={loading || !query.trim()} type="submit">
          Search
        </button>
      </form>
      <div className="list scrollList">
        {sections.map((section) => (
          <article className="row" key={section.id}>
            <div className="rowTop">
              <div>
                <h3>{section.heading}</h3>
                <p className="path">
                  {section.path}
                  {section.anchor ? `#${section.anchor}` : ""}
                </p>
              </div>
              <span className="pill" title="Section ID">
                {section.id}
              </span>
            </div>
            <p>{section.content.slice(0, 260)}</p>
          </article>
        ))}
        {sections.length === 0 ? <p className="empty">No search results loaded.</p> : null}
      </div>
    </>
  );
}

function RepositoryContextPanel({ repositories }: { repositories: RepositoryRef[] }) {
  return (
    <section className="surface">
      <div className="surfaceHeader">
        <h2>Repository Context</h2>
        <span className="pill" title="Indexed knowledge repositories">
          {repositories.length} repos
        </span>
      </div>
      <div className="surfaceBody">
        <div className="repositoryContextList">
          {repositories.map((repository) => (
            <article className="repositoryContext" key={repository.id}>
              <div className="rowTop">
                <div>
                  <h3>{repository.name}</h3>
                  <p className="path">{repository.localPath}</p>
                </div>
                <span className={`status ${repository.git?.scope ?? "unknown"}`} title={gitScopeLabel(repository.git?.scope)}>
                  {gitScopeLabel(repository.git?.scope)}
                </span>
              </div>
              <div className="gitContextGrid">
                <ContextValue label="Repository ID" value={repository.id} />
                <ContextValue label="Provider" value={repository.provider} />
                <ContextValue label="Branch" value={repository.git?.currentBranch ?? repository.defaultBranch} />
                <ContextValue label="HEAD" value={shortSha(repository.git?.headSha)} />
                <ContextValue label="Git Root" value={repository.git?.workTreeRoot ?? "Not detected"} />
                <ContextValue label="Indexed Folder" value={repository.git?.relativePathFromRoot ?? repository.git?.indexedPath ?? repository.localPath} />
                <ContextValue label="Remote" value={repository.git?.remoteUrl ?? repository.remoteUrl ?? "Not configured"} />
                <ContextValue label="Working Tree" value={repository.git?.hasUncommittedChanges ? "Uncommitted changes" : repository.git?.scope === "not-git" ? "Not a git work tree" : "Clean"} />
              </div>
            </article>
          ))}
          {repositories.length === 0 ? <p className="empty">No repository context available yet. Index a repository to detect its Git scope.</p> : null}
        </div>
      </div>
    </section>
  );
}

function ContextValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="contextValue">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function KnowledgeBrowser({
  documents,
  selectedDocument,
  setSelectedDocumentId
}: {
  documents: KnowledgeDocument[];
  selectedDocument?: KnowledgeDocument;
  setSelectedDocumentId: (id: string) => void;
}) {
  const folders = groupDocumentsByFolder(documents);
  return (
    <div className="documentBrowser">
      <div className="documentList">
        {folders.map((folder) => (
          <section className="folderGroup" key={folder.name}>
            <div className="folderHeader">
              <span>{folder.name}</span>
              <small>{folder.documents.length}</small>
            </div>
            {folder.documents.map((document) => (
              <button
                className={selectedDocument?.id === document.id ? "documentItem selected" : "documentItem"}
                key={document.id}
                onClick={() => setSelectedDocumentId(document.id)}
                type="button"
              >
                <span>{document.metadata.title}</span>
                <small>{document.path.split("/").at(-1) ?? document.path}</small>
                <span className={`status ${document.metadata.status}`} title={`Document status: ${document.metadata.status}`}>
                  {document.metadata.status}
                </span>
              </button>
            ))}
          </section>
        ))}
        {documents.length === 0 ? <p className="empty">No Markdown documents indexed yet.</p> : null}
      </div>
      <article className="documentPreview">
        {selectedDocument ? (
          <>
            <div className="rowTop">
              <div>
                <h2>{selectedDocument.metadata.title}</h2>
                <p className="path">{selectedDocument.path}</p>
              </div>
              <span className={`status ${selectedDocument.metadata.status}`} title={`Document status: ${selectedDocument.metadata.status}`}>
                {selectedDocument.metadata.status}
              </span>
            </div>
            <div className="rowActions">
              <span className="pill" title="Repository ID">
                {selectedDocument.repositoryId}
              </span>
              {selectedDocument.metadata.owner ? (
                <span className="pill" title="Document owner">
                  {selectedDocument.metadata.owner}
                </span>
              ) : null}
              {selectedDocument.metadata.tags.map((tag) => (
                <span className="pill" key={tag} title="Document tag">
                  {tag}
                </span>
              ))}
            </div>
            <pre className="markdownViewer">{selectedDocument.content}</pre>
          </>
        ) : (
          <p className="empty">Select a document to view its Markdown.</p>
        )}
      </article>
    </div>
  );
}

function groupDocumentsByFolder(documents: KnowledgeDocument[]): Array<{ name: string; documents: KnowledgeDocument[] }> {
  const groups = new Map<string, KnowledgeDocument[]>();
  for (const document of documents) {
    const segments = document.path.split("/");
    const folder = segments.length > 1 ? segments.slice(0, -1).join("/") : "/";
    groups.set(folder, [...(groups.get(folder) ?? []), document]);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, groupedDocuments]) => ({
      name,
      documents: groupedDocuments.sort((left, right) => left.path.localeCompare(right.path))
    }));
}

function gitScopeLabel(scope: GitRepositoryContext["scope"] | undefined): string {
  if (scope === "repository-root") {
    return "Git repo";
  }
  if (scope === "subdirectory") {
    return "Git subfolder";
  }
  if (scope === "not-git") {
    return "Not Git";
  }

  return "Unknown";
}

function shortSha(value: string | undefined): string {
  return value ? value.slice(0, 12) : "Unknown";
}

function RecentQuestions({
  expandedQuestionIds,
  onFeedback,
  onToggleGap,
  questions,
  toggleCitations
}: {
  expandedQuestionIds: string[];
  onFeedback: (questionId: string, feedback: Feedback) => Promise<void>;
  onToggleGap: (questionId: string, flagged: boolean) => Promise<void>;
  questions: QuestionLog[];
  toggleCitations: (questionId: string) => void;
}) {
  return (
    <div className="list scrollList">
      {questions.map((item) => {
        const citations = item.answer?.citations ?? [];
        const isExpanded = expandedQuestionIds.includes(item.id);

        return (
          <article className="row" key={item.id}>
            <div className="rowTop">
              <h3>{item.question}</h3>
              <span className={`status ${item.confidence}`} title={`Answer confidence: ${item.confidence}`}>
                {item.confidence}
              </span>
            </div>
            <p>{item.answer?.answer ?? "Waiting for an answer."}</p>
            <div className="rowActions">
              <span>{new Date(item.askedAt).toLocaleString()}</span>
              {citations.length > 0 ? (
                <button className="chip" onClick={() => toggleCitations(item.id)} title="Show or hide the answer source sections" type="button">
                  {isExpanded ? "Hide" : "Show"} {citations.length} citations
                </button>
              ) : (
                <span className="pill" title="No source sections were cited">
                  0 citations
                </span>
              )}
              <button
                className={item.feedback === "helpful" ? "chip selected" : "chip"}
                onClick={() => void onFeedback(item.id, "helpful")}
                type="button"
              >
                Helpful
              </button>
              <button
                className={item.feedback === "unhelpful" ? "chip selected" : "chip"}
                onClick={() => void onFeedback(item.id, "unhelpful")}
                type="button"
              >
                Unhelpful
              </button>
              <button
                className={item.manualGap ? "chip selected" : "chip"}
                onClick={() => void onToggleGap(item.id, !item.manualGap)}
                title="Flag this answer as a knowledge gap the system missed"
                type="button"
              >
                Knowledge gap
              </button>
            </div>
            {isExpanded && citations.length > 0 ? (
              <div className="citationStack">
                {citations.map((citation) => (
                  <CitationRow citation={citation} key={citation.sectionId} />
                ))}
              </div>
            ) : null}
          </article>
        );
      })}
      {questions.length === 0 ? <p className="empty">No questions logged yet.</p> : null}
    </div>
  );
}

function UploadPanel({
  onDropFiles,
  onUpload,
  setUploadContent,
  setUploadPath,
  uploadContent,
  uploading,
  uploadPath
}: {
  onDropFiles: (files: FileList | null) => Promise<void>;
  onUpload: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  setUploadContent: (value: string) => void;
  setUploadPath: (value: string) => void;
  uploadContent: string;
  uploading: boolean;
  uploadPath: string;
}) {
  return (
    <section className="uploadWorkspace">
      <form
        className="uploadForm"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          void onDropFiles(event.dataTransfer.files);
        }}
        onSubmit={onUpload}
      >
        <div className="uploadEditor">
          <label className="field">
            <span>Path</span>
            <input onChange={(event) => setUploadPath(event.target.value)} placeholder="uploaded/cats-note.md" value={uploadPath} />
          </label>
          <label className="field editorField">
            <span>Markdown</span>
            <textarea
              onChange={(event) => setUploadContent(event.target.value)}
              placeholder={"# Cat introductions\n\nKeep first meetings calm and supervised."}
              rows={14}
              value={uploadContent}
            />
          </label>
        </div>
        <div className="dropHint">Drop a Markdown file here or choose one below.</div>
        <div className="rowActions">
          <label className="fileButton">
            <input accept=".md,text/markdown,text/plain" onChange={(event) => void onDropFiles(event.target.files)} type="file" />
            Choose File
          </label>
          <button className="button" disabled={uploading || !uploadPath.trim() || !uploadContent.trim()} type="submit">
            {uploading ? "Indexing" : "Index Markdown"}
          </button>
        </div>
      </form>
    </section>
  );
}

function RepositoryPanel({
  indexing,
  onIndex,
  repoId,
  repoName,
  repoPath,
  setRepoId,
  setRepoName,
  setRepoPath
}: {
  indexing: boolean;
  onIndex: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  repoId: string;
  repoName: string;
  repoPath: string;
  setRepoId: (value: string) => void;
  setRepoName: (value: string) => void;
  setRepoPath: (value: string) => void;
}) {
  return (
    <form className="repositoryForm" onSubmit={onIndex}>
      <label className="field">
        <span>Local Path</span>
        <input
          onChange={(event) => setRepoPath(event.target.value)}
          placeholder="knowledge-bases/cats"
          title="Path to a local folder containing Markdown files. Relative paths resolve from the app workspace."
          value={repoPath}
        />
      </label>
      <label className="field">
        <span>Repository ID</span>
        <input
          onChange={(event) => setRepoId(event.target.value)}
          placeholder="cats"
          title="Optional stable ID used internally for this knowledge repository."
          value={repoId}
        />
      </label>
      <label className="field">
        <span>Name</span>
        <input
          onChange={(event) => setRepoName(event.target.value)}
          placeholder="Cats Knowledge Base"
          title="Optional display name for this knowledge repository."
          value={repoName}
        />
      </label>
      <button className="button" disabled={indexing || !repoPath.trim()} title="Index Markdown files from this repository" type="submit">
        {indexing ? "Indexing" : "Index Repository"}
      </button>
    </form>
  );
}

function GapPanel({
  draftProposal,
  gaps,
  loading
}: {
  draftProposal: (gap: GapCandidate) => Promise<void>;
  gaps: GapCandidate[];
  loading: boolean;
}) {
  return (
    <section className="surface">
      <div className="surfaceHeader">
        <h2>Gap Candidates</h2>
        <span className="pill" title="Number of open gap candidates">
          {gaps.length}
        </span>
      </div>
      <div className="surfaceBody">
        <div className="list scrollList">
          {gaps.map((gap) => (
            <article className="row" key={gap.summary}>
              <div className="rowTop">
                <h3>{gap.summary}</h3>
                <span className="pill countPill" title={`${gap.count} question${gap.count === 1 ? "" : "s"} grouped into this gap`}>
                  {formatQuestionCount(gap.count)}
                </span>
              </div>
              <p title="Question IDs grouped into this gap">{gap.questionIds.join(", ")}</p>
              <div className="rowActions">
                <span title="Most recent matching question">{new Date(gap.latestAskedAt).toLocaleString()}</span>
                <button
                  className="chip"
                  disabled={loading}
                  onClick={() => void draftProposal(gap)}
                  title="Queue a job to draft Markdown for this knowledge gap"
                  type="button"
                >
                  Draft Proposal
                </button>
              </div>
            </article>
          ))}
          {gaps.length === 0 ? <p className="empty">No gap candidates yet.</p> : null}
        </div>
      </div>
    </section>
  );
}

function JobsPanel({ jobs }: { jobs: AiJob[] }) {
  return (
    <section className="surface">
      <div className="surfaceHeader">
        <h2>AI Jobs</h2>
        <span className="pill" title="Number of AI jobs loaded">
          {jobs.length}
        </span>
      </div>
      <div className="surfaceBody">
        <div className="jobTable">
          <div className="tableHead">
            <span>Type</span>
            <span>Status</span>
            <span>Worker</span>
            <span>Updated</span>
          </div>
          {[...jobs].slice(-12).reverse().map((job) => (
            <div className="tableRow" key={job.id}>
              <span>{job.type}</span>
              <span className={`status ${job.status}`} title={`Job status: ${job.status}`}>
                {job.status}
              </span>
              <span>{job.claimedBy ?? "unclaimed"}</span>
              <span>{new Date(job.updatedAt).toLocaleString()}</span>
            </div>
          ))}
          {jobs.length === 0 ? <p className="empty">No AI jobs queued.</p> : null}
        </div>
      </div>
    </section>
  );
}

function ProposalLinks({
  openProposal,
  proposals
}: {
  openProposal: (proposalId: string) => void;
  proposals: Proposal[];
}) {
  return (
    <section className="surface">
      <div className="surfaceHeader">
        <h2>Proposals</h2>
        <span className="pill" title="Number of generated proposals">
          {proposals.length}
        </span>
      </div>
      <div className="surfaceBody">
        <div className="list scrollList">
          {proposals.map((proposal) => (
            <article className="row" key={proposal.id}>
              <div className="rowTop">
                <div>
                  <h3>{proposal.title}</h3>
                  <p className="path">{proposal.targetPath}</p>
                </div>
                <span className={`status ${proposal.status}`} title={`Proposal status: ${proposal.status}`}>
                  {proposal.status}
                </span>
              </div>
              {proposal.gapSummary ? <p>{proposal.gapSummary}</p> : null}
              <div className="rowActions">
                <button className="chip" onClick={() => openProposal(proposal.id)} title="Open this proposal for review" type="button">
                  Open Proposal
                </button>
                {proposal.jobId ? (
                  <span className="pill" title="AI job that generated this proposal">
                    {proposal.jobId}
                  </span>
                ) : null}
              </div>
            </article>
          ))}
          {proposals.length === 0 ? <p className="empty">No proposals generated yet.</p> : null}
        </div>
      </div>
    </section>
  );
}

function ProposalPanel({
  loading,
  publishProposal,
  proposals,
  selectedProposal,
  setSelectedProposalId,
  updateProposalStatus
}: {
  loading: boolean;
  publishProposal: (proposalId: string) => Promise<void>;
  proposals: Proposal[];
  selectedProposal?: Proposal;
  setSelectedProposalId: (id: string) => void;
  updateProposalStatus: (proposalId: string, status: Proposal["status"]) => Promise<void>;
}) {
  return (
    <section className="surface">
      <div className="surfaceHeader">
        <h2>Proposals</h2>
        <span className="pill" title="Number of generated proposals">
          {proposals.length}
        </span>
      </div>
      <div className="surfaceBody">
        <div className="proposalGrid">
          <div className="list scrollList">
            {proposals.map((proposal) => (
              <button
                className={selectedProposal?.id === proposal.id ? "proposalItem selected" : "proposalItem"}
                key={proposal.id}
                onClick={() => setSelectedProposalId(proposal.id)}
                type="button"
              >
                <span>{proposal.title}</span>
                <small className="path">{proposal.targetPath}</small>
              </button>
            ))}
            {proposals.length === 0 ? <p className="empty">No proposals generated yet.</p> : null}
          </div>
          <div className="proposalPreview">
            {selectedProposal ? (
              <>
                <div className="rowTop">
                  <div>
                    <h3>{selectedProposal.title}</h3>
                    <p className="path">{selectedProposal.targetPath}</p>
                  </div>
                  <span className={`status ${selectedProposal.status}`} title={`Proposal status: ${selectedProposal.status}`}>
                    {selectedProposal.status}
                  </span>
                </div>
                {selectedProposal.rationale ? <p>{selectedProposal.rationale}</p> : null}
                <div className="rowActions">
                  <button
                    className="chip selected"
                    disabled={loading || selectedProposal.status !== "draft"}
                    onClick={() => void updateProposalStatus(selectedProposal.id, "ready")}
                    title="Mark this draft as ready for the future PR workflow"
                    type="button"
                  >
                    Mark Ready
                  </button>
                  <button
                    className="chip selected"
                    disabled={loading || selectedProposal.status !== "ready"}
                    onClick={() => void publishProposal(selectedProposal.id)}
                    title="Create and push a Git branch for this ready proposal"
                    type="button"
                  >
                    Publish Branch
                  </button>
                  <button
                    className="chip"
                    disabled={loading || selectedProposal.status !== "draft"}
                    onClick={() => void updateProposalStatus(selectedProposal.id, "rejected")}
                    title="Reject this generated proposal"
                    type="button"
                  >
                    Reject
                  </button>
                  {selectedProposal.publication ? (
                    <span className="pill" title={`Published commit ${selectedProposal.publication.commitSha}`}>
                      {selectedProposal.publication.branchName}
                    </span>
                  ) : (
                    <span className="pill" title="Ready proposals can be published as Git branches">
                      Branch publish available
                    </span>
                  )}
                </div>
                {selectedProposal.publication ? (
                  <div className="publicationSummary">
                    <ContextValue label="Branch" value={selectedProposal.publication.branchName} />
                    <ContextValue label="Commit" value={shortSha(selectedProposal.publication.commitSha)} />
                    <ContextValue label="Remote" value={selectedProposal.publication.remoteUrl ?? "Not recorded"} />
                    <ContextValue label="Published" value={new Date(selectedProposal.publication.publishedAt).toLocaleString()} />
                  </div>
                ) : null}
                <pre>{selectedProposal.markdown}</pre>
              </>
            ) : (
              <p className="empty">Select a generated proposal to review its Markdown.</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function ConfigPanel({
  apiBaseUrl,
  config,
  onConfigChange,
  onMessage
}: {
  apiBaseUrl: string;
  config?: RuntimeConfig;
  onConfigChange: (config: RuntimeConfig) => void;
  onMessage: (message: string, tone?: UiMessage["tone"]) => void;
}) {
  const [executionMode, setExecutionMode] = useState<AiExecutionMode>("direct");
  const [provider, setProvider] = useState<AiProviderName>("mock");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!config) {
      return;
    }

    setExecutionMode(config.aiRuntime.executionMode);
    setProvider(config.aiRuntime.provider);
  }, [config]);

  if (!config) {
    return (
      <section className="surface">
        <div className="surfaceHeader">
          <h2>Runtime Config</h2>
        </div>
        <div className="surfaceBody">
          <p className="empty">Config has not loaded yet.</p>
        </div>
      </section>
    );
  }

  const providerOptions = config.aiRuntime.providers.filter((item) =>
    executionMode === "direct" ? item.supportsDirect : item.supportsQueue
  );
  const selectedProvider = providerOptions.some((item) => item.name === provider) ? provider : providerOptions[0]?.name ?? "mock";

  async function saveRuntimeConfig() {
    if (!config) {
      return;
    }

    setSaving(true);
    onMessage("");
    try {
      const result = await apiPost<RuntimeConfig>("/config", {
        ai: {
          executionMode,
          provider: selectedProvider
        }
      });
      onConfigChange(result);
      onMessage("Runtime AI config updated.", "success");
    } catch (error) {
      onMessage(errorMessage(error), "danger");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="surface">
      <div className="surfaceHeader">
        <h2>Runtime Config</h2>
        <span className="pill" title="Browser-facing API base URL">
          {apiBaseUrl}
        </span>
      </div>
      <div className="surfaceBody">
        <div className="runtimeEditor">
          <div className="configControl">
            <span>Execution</span>
            <div className="segmented" role="group" aria-label="AI execution mode">
              {config.aiRuntime.executionModes.map((mode) => (
                <button
                  className={executionMode === mode ? "segment active" : "segment"}
                  key={mode}
                  onClick={() => {
                    setExecutionMode(mode);
                    const nextProvider = config.aiRuntime.providers.find((item) =>
                      mode === "direct" ? item.supportsDirect : item.supportsQueue
                    )?.name;
                    if (nextProvider && !config.aiRuntime.providers.find((item) => item.name === provider && (mode === "direct" ? item.supportsDirect : item.supportsQueue))) {
                      setProvider(nextProvider);
                    }
                  }}
                  type="button"
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
          <label className="configControl">
            <span>Provider</span>
            <select onChange={(event) => setProvider(event.target.value as AiProviderName)} value={selectedProvider}>
              {providerOptions.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="button"
            disabled={
              saving ||
              (executionMode === config.aiRuntime.executionMode && selectedProvider === config.aiRuntime.provider)
            }
            onClick={() => void saveRuntimeConfig()}
            type="button"
          >
            {saving ? "Saving" : "Apply"}
          </button>
        </div>
        <div className="configGrid">
          <ConfigGroup title="API" value={{ ...config.api, browserApiBaseUrl: apiBaseUrl }} />
          <ConfigGroup title="Stores" value={config.stores} />
          <ConfigGroup title="Knowledge" value={config.knowledge} />
          <ConfigGroup title="Providers" value={config.providers} />
          <ConfigGroup title="Watcher" value={config.watcher} />
        </div>
      </div>
    </section>
  );
}

function ConfigGroup({ title, value }: { title: string; value: Record<string, unknown> }) {
  return (
    <section className="configGroup">
      <h3>{title}</h3>
      <dl>
        {Object.entries(flattenConfig(value)).map(([key, itemValue]) => (
          <div className="configRow" key={key}>
            <dt>{key}</dt>
            <dd>{String(itemValue ?? "not set")}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function flattenConfig(value: Record<string, unknown>, prefix = ""): Record<string, string | number | null> {
  return Object.entries(value).reduce<Record<string, string | number | null>>((result, [key, itemValue]) => {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (itemValue && typeof itemValue === "object" && !Array.isArray(itemValue)) {
      return {
        ...result,
        ...flattenConfig(itemValue as Record<string, unknown>, nextKey)
      };
    }

    result[nextKey] = typeof itemValue === "string" || typeof itemValue === "number" || itemValue === null ? itemValue : JSON.stringify(itemValue);
    return result;
  }, {});
}

function Metric({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "good" | "bad" | "neutral" }) {
  return (
    <div className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function NavButton({
  active,
  count,
  glyph,
  label,
  onClick
}: {
  active: boolean;
  count?: number;
  glyph: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button className={active ? "navButton active" : "navButton"} onClick={onClick} title={`Open ${label}`} type="button">
      <span className="navGlyph">{glyph}</span>
      <span>{label}</span>
      {count === undefined ? null : (
        <span className="pill" title={`${count} ${label.toLowerCase()} item${count === 1 ? "" : "s"}`}>
          {count}
        </span>
      )}
    </button>
  );
}

function TabButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button className={active ? "tab active" : "tab"} onClick={onClick} type="button">
      {label}
    </button>
  );
}

function CitationRow({ citation }: { citation: Citation }) {
  return (
    <div className="citation">
      <div className="citationTop">
        <strong>{citation.heading}</strong>
        <code>{citation.sectionId}</code>
      </div>
      <span>
        {citation.path}
        {citation.anchor ? `#${citation.anchor}` : ""}
      </span>
      <p>{citation.excerpt}</p>
    </div>
  );
}

function sectionTitle(section: ConsoleSection): string {
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
  if (section === "config") {
    return "Inspect runtime configuration";
  }

  return "Ask and inspect cited answers";
}

function formatQuestionCount(count: number): string {
  return `${count} question${count === 1 ? "" : "s"}`;
}

function sectionSubtitle(section: ConsoleSection): string {
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
  if (section === "config") {
    return "Check execution mode, stores, providers, repository paths, and whether secrets are set.";
  }

  return "Ask questions, review recent answers, and expand citations only when you need the source trail.";
}

function buildAttentionNotices({
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

function isActiveJob(job: AiJob): boolean {
  return job.status === "pending" || job.status === "claimed";
}

function jobTransitionMessages(previousJobs: AiJob[], nextJobs: AiJob[]): JobTransitionMessage[] {
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

function formatJobType(type: string): string {
  return type
    .split("_")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${resolveApiBaseUrl()}${path}`);
  return readResponse<T>(response);
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${resolveApiBaseUrl()}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return readResponse<T>(response);
}

async function apiDelete<T>(path: string): Promise<T> {
  const response = await fetch(`${resolveApiBaseUrl()}${path}`, { method: "DELETE" });
  return readResponse<T>(response);
}

async function readResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(typeof body.message === "string" ? body.message : text || response.statusText);
  }

  return body as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected console error";
}
