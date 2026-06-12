"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

const apiBaseUrl = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000").replace(/\/+$/, "");

type Confidence = "high" | "medium" | "low" | "unknown";
type Feedback = "helpful" | "unhelpful";

interface Health {
  ok: boolean;
  service: string;
}

interface KnowledgeStats {
  repositoryCount: number;
  documentCount: number;
  sectionCount: number;
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

interface Proposal {
  id: string;
  title: string;
  status: string;
  targetPath: string;
  markdown: string;
  gapSummary?: string;
  triggeringQuestionIds?: string[];
  rationale?: string;
  jobId?: string;
  createdAt: string;
}

interface SearchSection {
  id: string;
  path: string;
  heading: string;
  content: string;
}

interface AskResponse {
  mode: string;
  questionId: string;
  result?: AnswerResult;
  job?: AiJob;
}

export default function HomePage() {
  const [health, setHealth] = useState<Health | undefined>();
  const [stats, setStats] = useState<KnowledgeStats>({ repositoryCount: 0, documentCount: 0, sectionCount: 0 });
  const [questions, setQuestions] = useState<QuestionLog[]>([]);
  const [gaps, setGaps] = useState<GapCandidate[]>([]);
  const [jobs, setJobs] = useState<AiJob[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [selectedProposalId, setSelectedProposalId] = useState<string | undefined>();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AskResponse | undefined>();
  const [query, setQuery] = useState("");
  const [sections, setSections] = useState<SearchSection[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | undefined>();
  const [message, setMessage] = useState("");

  const latestJob = useMemo(
    () => [...jobs].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0],
    [jobs]
  );
  const selectedProposal = proposals.find((proposal) => proposal.id === selectedProposalId) ?? proposals[0];

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    setRefreshing(true);
    setMessage("");
    try {
      const [healthResult, statsResult, questionsResult, gapsResult, jobsResult, proposalsResult] = await Promise.all([
        apiGet<Health>("/health"),
        apiGet<KnowledgeStats>("/knowledge/stats"),
        apiGet<{ questions: QuestionLog[] }>("/questions?limit=8"),
        apiGet<{ gaps: GapCandidate[] }>("/gaps/candidates?limit=8"),
        apiGet<{ jobs: AiJob[] }>("/ai-jobs"),
        apiGet<{ proposals: Proposal[] }>("/proposals?limit=8")
      ]);

      setHealth(healthResult);
      setStats(statsResult);
      setQuestions(questionsResult.questions);
      setGaps(gapsResult.gaps);
      setJobs(jobsResult.jobs);
      setProposals(proposalsResult.proposals);
      setSelectedProposalId((current) => current ?? proposalsResult.proposals[0]?.id);
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
      setMessage(errorMessage(error));
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
    setMessage("");
    try {
      const result = await apiPost<AskResponse>("/ask", { question: question.trim() });
      setAnswer(result);
      setQuestion("");
      await refresh();
    } catch (error) {
      setMessage(errorMessage(error));
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
    setMessage("");
    try {
      const result = await apiGet<{ sections: SearchSection[] }>(`/search?q=${encodeURIComponent(query.trim())}&limit=6`);
      setSections(result.sections);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  async function sendFeedback(questionId: string, feedback: Feedback) {
    setMessage("");
    try {
      const result = await apiPost<{ question: QuestionLog }>(`/questions/${questionId}/feedback`, { feedback });
      setQuestions((current) => current.map((item) => (item.id === questionId ? result.question : item)));
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function draftProposal(gap: GapCandidate) {
    setLoading(true);
    setMessage("");
    try {
      await apiPost<{ job: AiJob }>("/proposals/from-gap", {
        summary: gap.summary,
        targetPath: "knowledge-bases/cats/proposed-gap.md"
      });
      await refresh();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Markdown Magpie</p>
          <h1>Knowledge Console</h1>
        </div>
        <div className="refreshControls">
          <button className="button secondary" disabled={refreshing} onClick={() => void refresh()} type="button">
            {refreshing ? "Refreshing" : "Refresh"}
          </button>
          <span aria-live="polite">{lastRefreshedAt ? `Updated ${new Date(lastRefreshedAt).toLocaleTimeString()}` : "Not refreshed yet"}</span>
        </div>
      </header>

      {message ? <div className="alert">{message}</div> : null}

      <section className="metrics" aria-label="System status">
        <Metric label="API" value={health?.ok ? "Online" : "Offline"} tone={health?.ok ? "good" : "bad"} />
        <Metric label="Repositories" value={stats.repositoryCount.toString()} />
        <Metric label="Documents" value={stats.documentCount.toString()} />
        <Metric label="Sections" value={stats.sectionCount.toString()} />
        <Metric label="Latest Job" value={latestJob ? latestJob.status : "None"} tone={latestJob?.status === "failed" ? "bad" : "neutral"} />
      </section>

      <section className="workspace">
        <div className="toolPane">
          <div className="paneHeader">
            <h2>Ask</h2>
            <span className="pill">{answer?.mode ?? "mock"}</span>
          </div>
          <form className="stack" onSubmit={ask}>
            <label className="field">
              <span>Question</span>
              <textarea
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="How do we roll back a hotfix?"
                rows={4}
                value={question}
              />
            </label>
            <button className="button" disabled={loading || !question.trim()} type="submit">
              Ask
            </button>
          </form>

          {answer ? (
            <div className="resultBlock">
              <div className="resultHeader">
                <span className={`status ${answer.result?.confidence ?? "unknown"}`}>{answer.result?.confidence ?? "queued"}</span>
                <span>{answer.questionId}</span>
              </div>
              <p>{answer.result?.answer ?? `Queued as ${answer.job?.type ?? "AI job"}`}</p>
              {answer.result?.citations.map((citation) => (
                <CitationRow citation={citation} key={citation.sectionId} />
              ))}
            </div>
          ) : null}
        </div>

        <div className="toolPane">
          <div className="paneHeader">
            <h2>Search</h2>
            <span className="pill">{sections.length} results</span>
          </div>
          <form className="inlineForm" onSubmit={search}>
            <input
              onChange={(event) => setQuery(event.target.value)}
              placeholder="rollback"
              type="search"
              value={query}
            />
            <button className="button" disabled={loading || !query.trim()} type="submit">
              Search
            </button>
          </form>
          <div className="list">
            {sections.map((section) => (
              <article className="row" key={section.id}>
                <div>
                  <h3>{section.heading}</h3>
                  <p className="path">{section.path}</p>
                </div>
                <p>{section.content.slice(0, 220)}</p>
              </article>
            ))}
            {sections.length === 0 ? <p className="empty">No search results loaded.</p> : null}
          </div>
        </div>
      </section>

      <section className="lowerGrid">
        <div className="toolPane">
          <div className="paneHeader">
            <h2>Recent Questions</h2>
            <span className="pill">{questions.length}</span>
          </div>
          <div className="list compact">
            {questions.map((item) => (
              <article className="row" key={item.id}>
                <div className="rowTop">
                  <h3>{item.question}</h3>
                  <span className={`status ${item.confidence}`}>{item.confidence}</span>
                </div>
                <p>{item.answer?.answer ?? "Waiting for an answer."}</p>
                <div className="rowActions">
                  <span>{new Date(item.askedAt).toLocaleString()}</span>
                  <button
                    className={item.feedback === "helpful" ? "chip selected" : "chip"}
                    onClick={() => sendFeedback(item.id, "helpful")}
                    type="button"
                  >
                    Helpful
                  </button>
                  <button
                    className={item.feedback === "unhelpful" ? "chip selected" : "chip"}
                    onClick={() => sendFeedback(item.id, "unhelpful")}
                    type="button"
                  >
                    Unhelpful
                  </button>
                </div>
              </article>
            ))}
            {questions.length === 0 ? <p className="empty">No questions logged yet.</p> : null}
          </div>
        </div>

        <div className="toolPane">
          <div className="paneHeader">
            <h2>Gap Candidates</h2>
            <span className="pill">{gaps.length}</span>
          </div>
          <div className="list compact">
            {gaps.map((gap) => (
              <article className="row" key={gap.summary}>
                <div className="rowTop">
                  <h3>{gap.summary}</h3>
                  <span className="status low">{gap.count}</span>
                </div>
                <p>{gap.questionIds.join(", ")}</p>
                <div className="rowActions">
                  <span>{new Date(gap.latestAskedAt).toLocaleString()}</span>
                  <button className="chip" disabled={loading} onClick={() => draftProposal(gap)} type="button">
                    Draft Proposal
                  </button>
                </div>
              </article>
            ))}
            {gaps.length === 0 ? <p className="empty">No gap candidates yet.</p> : null}
          </div>
        </div>

        <div className="toolPane wide">
          <div className="paneHeader">
            <h2>AI Jobs</h2>
            <span className="pill">{jobs.length}</span>
          </div>
          <div className="jobTable">
            <div className="tableHead">
              <span>Type</span>
              <span>Status</span>
              <span>Worker</span>
              <span>Updated</span>
            </div>
            {[...jobs].slice(-8).reverse().map((job) => (
              <div className="tableRow" key={job.id}>
                <span>{job.type}</span>
                <span className={`status ${job.status}`}>{job.status}</span>
                <span>{job.claimedBy ?? "unclaimed"}</span>
                <span>{new Date(job.updatedAt).toLocaleString()}</span>
              </div>
            ))}
            {jobs.length === 0 ? <p className="empty">No AI jobs queued.</p> : null}
          </div>
        </div>

        <div className="toolPane wide">
          <div className="paneHeader">
            <h2>Proposals</h2>
            <span className="pill">{proposals.length}</span>
          </div>
          <div className="proposalGrid">
            <div className="list compact">
              {proposals.map((proposal) => (
                <button
                  className={selectedProposal?.id === proposal.id ? "proposalItem selected" : "proposalItem"}
                  key={proposal.id}
                  onClick={() => setSelectedProposalId(proposal.id)}
                  type="button"
                >
                  <span>{proposal.title}</span>
                  <small>{proposal.targetPath}</small>
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
                    <span className="status pending">{selectedProposal.status}</span>
                  </div>
                  {selectedProposal.rationale ? <p>{selectedProposal.rationale}</p> : null}
                  <pre>{selectedProposal.markdown}</pre>
                </>
              ) : (
                <p className="empty">Select a generated proposal to review its Markdown.</p>
              )}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function Metric({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "good" | "bad" | "neutral" }) {
  return (
    <div className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CitationRow({ citation }: { citation: Citation }) {
  return (
    <div className="citation">
      <strong>{citation.heading}</strong>
      <span>{citation.path}</span>
      <p>{citation.excerpt}</p>
    </div>
  );
}

async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`);
  return readResponse<T>(response);
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
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
