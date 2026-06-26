export type Confidence = "high" | "medium" | "low" | "unknown";

export type KnowledgeStatus = "active" | "draft" | "deprecated" | "archived";

export interface RepositoryRef {
  id: string;
  name: string;
  remoteUrl?: string;
  defaultBranch: string;
  localPath: string;
  provider: "local" | "github" | "gitlab" | "azure-devops";
  git?: GitRepositoryContext;
}

export interface GitRepositoryContext {
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

export interface DocumentMetadata {
  title: string;
  owner?: string;
  status: KnowledgeStatus;
  lastVerified?: string;
  reviewCycleDays?: number;
  tags: string[];
  relatedDocs: string[];
}

export interface KnowledgeDocument {
  id: string;
  repositoryId: string;
  path: string;
  commitSha?: string;
  metadata: DocumentMetadata;
  content: string;
}

export interface DocumentSection {
  id: string;
  documentId: string;
  path: string;
  heading: string;
  headingPath: string[];
  anchor: string;
  content: string;
  ordinal: number;
}

export interface RankedSection {
  section: DocumentSection;
  /** Absolute relevance in [0,1]; higher is better. */
  relevance: number;
}

export interface Citation {
  documentId: string;
  sectionId: string;
  path: string;
  heading: string;
  anchor: string;
  commitSha?: string;
  excerpt: string;
}

export interface AnswerResult {
  answer: string;
  confidence: Confidence;
  citations: Citation[];
  // A single question can expose several distinct knowledge gaps (e.g. asking
  // "how do I set this up with React so I can export dashboards?" is two gaps).
  // Each is tracked separately so it can cluster and become its own proposal.
  gaps?: KnowledgeGapSignal[];
}

export interface KnowledgeGapSignal {
  summary: string;
  question: string;
  confidence: Confidence;
  citedSectionIds: string[];
}

export type QuestionGapSource = "auto" | "manual";

export interface QuestionGap {
  summary: string;
  source: QuestionGapSource;
  // Set when a merged proposal closes this gap. A resolved gap is retained for
  // audit but no longer surfaces as a candidate.
  resolvedAt?: string;
  resolvedByProposalId?: string;
}

export interface QuestionLog {
  id: string;
  question: string;
  chatProvider: string;
  confidence: Confidence;
  retrievedSectionIds: string[];
  // The flow this question was routed to (scopes retrieval + persona). Recorded
  // so a gap can later be attributed to the flow that produced it. Absent for
  // un-routed/legacy questions.
  flowId?: string;
  askedAt: string;
  answer?: AnswerResult;
  feedback?: QuestionFeedback;
  feedbackAt?: string;
  gaps?: QuestionGap[];
  manualGap?: boolean;
  manualGapAt?: string;
}

export interface QuestionLogInput {
  question: string;
  chatProvider: string;
  answer?: AnswerResult;
  retrievedSectionIds: string[];
  flowId?: string;
}

export interface QuestionLogUpdateInput {
  answer: AnswerResult;
  chatProvider?: string;
  // The flow the question was routed to, recorded on completion. The watcher
  // decides this after the log is first created, so it lands here, not at record
  // time. Absent when no flow was chosen.
  flowId?: string;
}

export type QuestionFeedback = "helpful" | "unhelpful";

export interface GapCandidate {
  summary: string;
  questionIds: string[];
  count: number;
  latestAskedAt: string;
  confidence: Confidence;
  // The flow whose questions surfaced this gap. Candidates are grouped per flow,
  // so the same summary asked under two flows yields two candidates. Absent when
  // the underlying questions were not routed to a flow.
  flowId?: string;
}

export interface GapCluster {
  id: string;
  summary: string;
  questionIds: string[];
  priority: number;
  status: "open" | "proposed" | "dismissed" | "resolved";
}

// A semantic grouping of gap candidates that could be addressed by a single
// knowledge-base article (e.g. "do cats like cheese?", "is cheese bad for
// cats?", "what if a cat eats a lot of cheese?" are one cluster). Clusters are
// only ever *suggestions* — they are recomputed on demand and never persisted,
// because the human reviewer can regroup them before drafting. One drafted
// proposal is produced per cluster the reviewer confirms.
export interface SuggestedGapCluster {
  id: string;
  title: string;
  summaries: string[];
  questionIds: string[];
  count: number;
  rationale?: string;
  // Every member of a cluster belongs to the same flow (clustering runs per
  // flow), so a drafted proposal can default to this flow's destination/persona.
  flowId?: string;
}

// What GET /api/gaps/clusters now returns: an active persisted cluster. Keeps
// every field SuggestedGapCluster exposed (so the UI is unchanged) and adds the
// persisted lineage fields. `id` is a stable surrogate that survives membership
// changes — unlike the content-hash id the on-demand clusterer produced.
export interface PersistedGapCluster {
  id: string;
  title: string;
  summaries: string[];
  questionIds: string[];
  count: number;
  rationale?: string;
  flowId?: string;
  status: "active";
  proposalId?: string;
  proposalStatus?: Proposal["status"];
  lastReconciledAt?: string;
}

// The watcher's normalised reading of a pull request's review state. Only
// "approved" locks a PR against folding; every other value — and the absence of
// any value — leaves it touchable. Derived from GitHub's GraphQL reviewDecision,
// falling back to its REST reviews list (see @magpie/git fetchPullRequestReviewDecision).
export type ReviewDecision = "approved" | "changes_requested" | "review_required" | "none";

// The single source of truth for a proposal's publish-lifecycle stages. Declared
// as a runtime tuple (not a bare union) so consumers that need the values at
// runtime — e.g. a zod enum in @magpie/jobs — derive from this one list rather
// than duplicating the literals and drifting.
export const PROPOSAL_STATUSES = [
  "draft",
  "ready",
  "branch-pushed",
  "pr-opened",
  "merged",
  "rejected",
  "superseded"
] as const;
type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export interface Proposal {
  id: string;
  title: string;
  status: ProposalStatus;
  targetPath: string;
  markdown: string;
  // When present, this proposal writes/deletes multiple files and is the source of
  // truth for both publication and gate overlap. When absent, the proposal is the
  // single-file [{ path: targetPath, content: markdown }] it has always been.
  // dedupe (and later split) set it; gap/verify/source-sync leave it undefined.
  // The proposal still carries a sensible targetPath + markdown — its primary doc,
  // from which the title, branch name, and PR body derive.
  changeset?: ChangesetChange[];
  evidence: Citation[];
  gapClusterId?: string;
  // The flow this proposal belongs to, independent of any gap cluster. Gap
  // proposals leave this unset and resolve their flow via the cluster; patrol-lens
  // proposals (verify, and later dedupe/split/complete) set it directly so the
  // reconcile gate sees them as same-flow and the per-flow outbox drains them.
  flowId?: string;
  gapSummary?: string;
  triggeringQuestionIds?: string[];
  destinationId?: string;
  rationale?: string;
  jobId?: string;
  publication?: ProposalPublication;
  // The latest review decision observed on this proposal's pull request, polled by
  // the watcher's refresh_pull_requests job. Absent until the PR has been polled (or
  // for proposals drafted before this was tracked). An approved PR is non-touchable:
  // the reconcile gate will not fold another change into it.
  reviewDecision?: ReviewDecision;
  // A compact record of the context the model was given when it drafted this
  // proposal — the gaps, the source files, how much evidence, and the flow's
  // in-flight work it was told about. Lets a reviewer see what the draft was
  // based on, not just its output. Absent on proposals drafted before this was
  // captured.
  draftContext?: DraftContext;
  createdAt: string;
  // Stamped when the proposal is marked merged. Marking merged also resolves the
  // gaps it closed so they stop surfacing as candidates.
  mergedAt?: string;
}

// The inputs handed to the drafter, kept alongside the proposal so the context
// is inspectable after the fact. Deliberately compact: source file identities,
// not their bodies.
export interface DraftContext {
  // The gap summaries the draft set out to close.
  gapSummaries: string[];
  // The source files the model received as raw material (identity only).
  sourceFiles: Array<{ sourceName: string; path?: string; url?: string }>;
  // How many evidence citations were attached.
  evidenceCount: number;
  // The flow's in-flight proposals / open pull requests the model was shown.
  openPullRequests: OpenPullRequestContext[];
}

// Canonical location for a drafted proposal within its destination repository.
// The folder is always owned by us (the destination's configured docs subpath),
// never chosen by the AI or hard-coded per call site, so every proposal lands in
// a consistent place on its branch. The "proposed" state is represented by the
// branch/PR, so the doc is written to its final home — no staging prefix.
export function proposalFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return `${slug || "knowledge-gap"}.md`;
}

export function resolveProposalTargetPath(subpath: string | undefined, title: string): string {
  const folder = (subpath ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const fileName = proposalFileName(title);
  return folder ? `${folder}/${fileName}` : fileName;
}

export interface ProposalPublication {
  provider: "local-git";
  branchName: string;
  commitSha: string;
  remoteUrl?: string;
  pullRequestUrl?: string;
  publishedAt: string;
}

export interface ChatProvider {
  complete(request: ChatRequest): Promise<ChatResponse>;
}

export interface ChatRequest {
  system: string;
  messages: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  // Optional caller-supplied cancellation. When the watcher aborts in-flight work
  // (job cancelled or shutdown) the underlying fetch is torn down, not abandoned.
  signal?: AbortSignal;
}

export interface ChatResponse {
  content: string;
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

export interface AnswerQuestionJobInput {
  questionLogId?: string;
  question: string;
  // Routing candidates the watcher chooses between. The watcher routes the
  // question to one of these flows (a generative call it owns), then retrieves
  // scoped context via POST /api/retrieve, then answers. May be empty when no
  // flows are configured, in which case the watcher answers unscoped.
  flows: Array<{
    id: string;
    name: string;
    // NOTE: persona is plumbed through but currently inert — Task 7's answer
    // runner will apply the chosen flow's persona to the prompt. Until then it
    // is carried but not consumed.
    persona?: string;
  }>;
  expectedOutput: "answer_result";
}

// Result of routing a question to the single best-matching knowledge flow.
export interface FlowRouteDecision {
  flowId: string;
  confidence: Confidence;
  rationale?: string;
}

export interface AnswerQuestionJobOutput {
  answer: string;
  confidence: Confidence;
  citations: Citation[];
  gaps?: KnowledgeGapSignal[];
  // The flow the watcher routed the question to, recorded on completion so the
  // question log reflects which flow answered. Absent when no flow was chosen.
  flowId?: string;
}

export interface SummarizeGapJobInput {
  questions: string[];
  citedSections: Citation[];
  expectedOutput: "gap_summary";
}

export interface SummarizeGapJobOutput {
  summary: string;
  priority: number;
  rationale: string;
}

export interface DraftMarkdownProposalJobInput {
  // One proposal can address several related gaps at once (a confirmed cluster),
  // so the drafter receives every gap summary in the cluster and writes a single
  // cohesive article covering all of them.
  gapSummaries: string[];
  triggeringQuestions: string[];
  evidence: Citation[];
  sourceContext?: SourceDataContext[];
  // The flow's already in-flight proposals and currently open pull requests, so
  // the drafter is aware of work it should build on or avoid duplicating rather
  // than drafting in a vacuum. Optional and defaults to absent.
  openPullRequests?: OpenPullRequestContext[];
  destinationId?: string;
  targetPath?: string;
  // The ids of the question logs that triggered this draft, threaded through so the
  // created proposal links back to them (read in createProposalFromCompletedJob).
  // Optional: the on-demand HTTP draft path and tests omit it.
  triggeringQuestionIds?: string[];
  // The gap cluster this draft belongs to, so the created proposal can be linked
  // back to it on the autonomous path. Absent on the on-demand HTTP draft path.
  gapClusterId?: string;
  expectedOutput: "markdown_proposal";
}

// One piece of in-flight drafting work in a flow, surfaced to a new draft so it
// can cross-reference or steer clear of it. Sourced from the flow's on-disk
// snapshot — not a live host lookup.
export interface OpenPullRequestContext {
  // What the in-flight work is about.
  title: string;
  // The pull request URL once one is open; absent while the proposal is still in
  // draft/ready/branch-pushed (no PR raised yet).
  url?: string;
  // The destination document the work targets, so a draft can avoid landing a
  // second article on the same path.
  targetPath?: string;
  // Where the work currently sits in the publish lifecycle.
  status: Proposal["status"];
}

export interface SourceDataContext {
  sourceId: string;
  sourceName: string;
  kind: "local" | "git" | "internet" | "agent";
  path?: string;
  url?: string;
  content?: string;
}

// One claim in a knowledge-base document the verify lens could not substantiate
// against the document's source material, with the model's reason.
export interface UnprovableClaim {
  claim: string;
  reason: string;
}

// Input to the verify_document AI job: one knowledge-base document plus the source
// material to check it against. `provider` is added at enqueue (see @magpie/jobs).
export interface VerifyDocumentJobInput {
  path: string;
  content: string;
  sources: SourceDataContext[];
}

// The verify lens's verdict for one document: "healthy" (claims empty) or
// "unprovable" with the specific claims the sources fail to support.
export interface VerifyDocumentJobOutput {
  verdict: "healthy" | "unprovable";
  claims: UnprovableClaim[];
}

// Input to the correct_document AI job: a document the verify lens flagged as
// unprovable, the specific claims to repair, and the source material to ground the
// repair in. `provider` is added at enqueue (see @magpie/jobs).
export interface CorrectDocumentJobInput {
  path: string;
  content: string;
  claims: UnprovableClaim[];
  sources: SourceDataContext[];
  destinationId?: string;
  flowId?: string;
}

// Output of the correct_document job: the full corrected document body (each
// flagged claim rewritten to match a source excerpt, or removed when unsupportable)
// plus a short rationale.
export interface CorrectDocumentJobOutput {
  markdown: string;
  rationale: string;
}

// Input to the dedupe_documents AI job: the document under patrol plus its k nearest
// neighbours (already filtered by similarity and capped). The job decides whether A
// genuinely duplicates/contradicts one neighbour and, if so, returns the pairwise
// changeset. `provider` is added at enqueue (see @magpie/jobs).
export interface DedupeDocumentsJobInput {
  path: string;
  content: string;
  neighbours: Array<{ path: string; content: string }>;
  destinationId?: string;
  flowId?: string;
}

// Output of the dedupe_documents job. Conservative: `duplicate` is false unless A and
// exactly one neighbour are a real duplicate/contradiction. When true, `changeset` is
// the pairwise file-set (rewrite the survivor, trim or delete the other) and
// `primaryPath` names the survivor (doc A).
export interface DedupeDocumentsJobOutput {
  duplicate: boolean;
  rationale: string;
  primaryPath?: string;
  changeset?: ChangesetChange[];
}

export interface SplitDocumentJobInput {
  path: string;
  content: string;
  neighbours: Array<{ path: string; content: string }>;
  destinationId?: string;
  flowId?: string;
}

export interface SplitDocumentJobOutput {
  split: boolean;
  rationale: string;
  primaryPath?: string;
  changeset?: ChangesetChange[];
}

export interface DraftMarkdownProposalJobOutput {
  title: string;
  targetPath: string;
  markdown: string;
  rationale: string;
}

export interface FoldMarkdownProposalJobInput {
  // The open proposal the rival is folded into; its markdown is updated in place.
  survivorProposalId: string;
  // The freshly-drafted proposal being absorbed, then superseded.
  rivalProposalId: string;
  targetPath: string;
  survivorMarkdown: string;
  rivalMarkdown: string;
  rivalGapSummaries: string[];
  rivalEvidence: Citation[];
  expectedOutput: "folded_markdown";
}

export interface FoldMarkdownProposalJobOutput {
  markdown: string;
  rationale: string;
}

// Input to the fold_changeset_proposal AI job: a multi-file (dedupe/split) rival that
// overlaps an open survivor PR on at least one path. The model reconciles the two
// file-sets into one unified changeset over their union. `provider` is added at enqueue.
export interface FoldChangesetProposalJobInput {
  survivorProposalId: string;
  rivalProposalId: string;
  survivorChangeset: ChangesetChange[];
  rivalChangeset: ChangesetChange[];
  // The paths both file-sets touch — where the model must apply both edits coherently.
  sharedPaths: string[];
  expectedOutput: "folded_changeset";
}

// Output of the fold_changeset_proposal job: the unified file-set the survivor PR is
// promoted to, plus a short rationale.
export interface FoldChangesetProposalJobOutput {
  changeset: ChangesetChange[];
  rationale: string;
}

export interface PullRequestProvider {
  createPullRequest(request: CreatePullRequestRequest): Promise<CreatePullRequestResponse>;
}

export interface CreatePullRequestRequest {
  repository: RepositoryRef;
  branchName: string;
  title: string;
  body: string;
  changes: Array<{
    path: string;
    content: string;
  }>;
}

export interface CreatePullRequestResponse {
  id: string;
  url: string;
  status: "open";
}

export interface PublishProposalBranchRequest {
  repository: RepositoryRef;
  branchName: string;
  title: string;
  markdown: string;
  targetPath: string;
}

export interface PublishProposalBranchResponse {
  branchName: string;
  commitSha: string;
  remoteUrl?: string;
}

// ---------------------------------------------------------------------------
// Crunch — scheduled knowledge-base tidying
//
// Over time an answer-driven knowledge base fragments: overlapping notes pile
// up and single documents grow to cover several unrelated topics. "Crunch" is a
// scheduled AI maintenance pass that proposes structural fixes — consolidating
// overlapping documents and splitting bloated ones — and lands the result on a
// review branch. Unlike a Proposal (one Markdown file), a crunch plan is
// inherently multi-file: it writes and deletes several documents at once.
// ---------------------------------------------------------------------------

export type CrunchOperationKind = "consolidate" | "split" | "rewrite";

export interface CrunchFileWrite {
  path: string;
  content: string;
}

export interface CrunchOperation {
  kind: CrunchOperationKind;
  title: string;
  reason: string;
  // Existing document paths this operation reorganizes (read and usually
  // replaced). Kept for the reviewer to see what was touched.
  sources: string[];
  writes: CrunchFileWrite[];
  deletes: string[];
}

export interface CrunchPlan {
  summary: string;
  operations: CrunchOperation[];
  rationale: string;
}

export interface CrunchKnowledgeBaseJobInput {
  flowId?: string;
  destinationId?: string;
  documents: CrunchFileWrite[];
  expectedOutput: "crunch_plan";
}

export type CrunchKnowledgeBaseJobOutput = CrunchPlan;

export type CrunchRunTrigger = "scheduled" | "manual";

export type CrunchRunStatus = "pending" | "running" | "completed" | "failed" | "published";

export interface CrunchRun {
  id: string;
  flowId?: string;
  destinationId?: string;
  trigger: CrunchRunTrigger;
  status: CrunchRunStatus;
  jobId?: string;
  plan?: CrunchPlan;
  error?: string;
  documentCount: number;
  publication?: ProposalPublication;
  createdAt: string;
  completedAt?: string;
}

export interface CrunchSettings {
  flowId?: string;
  enabled: boolean;
  // Standard 5-field cron expression (minute hour day-of-month month day-of-week).
  // Next-run timing is owned by pg-boss now, not derived/stored here.
  cron: string;
}

// ---------------------------------------------------------------------------
// Source-change sync — keep the knowledge base honest against its sources
//
// Crunch reorganizes the knowledge base against *itself*. Source-change sync
// corrects it against its *sources*: when an upstream source commit changes the
// underlying behaviour the KB describes (e.g. a cutoff moves from 2024 to 2025),
// any KB document that still asserts the old fact is now wrong. This pass detects
// changed source commits, retrieves the KB documents that already speak to the
// change, and asks the model to rewrite only those documents to match the new
// reality — landing the result on a review branch. The plan reuses CrunchPlan:
// the output is the same multi-file write/delete changeset.
// ---------------------------------------------------------------------------

export type SourceSyncRunTrigger = "scheduled" | "manual";

// "skipped" records a detected source change that needed no KB edit (nothing in
// the KB matched it, or the model returned an empty plan) — kept for the operator
// to see that the change was considered. "deferred" records a change whose target
// file-set overlaps an open PR in the same flow: the changeset is preserved and
// re-gated on a later source-sync tick rather than published as a rival (see
// docs/maintenance-redesign.md §5 and the source-sync gate hook).
export type SourceSyncRunStatus = "running" | "completed" | "failed" | "published" | "skipped" | "deferred";

// The last source commit a flow has reacted to. The next run diffs the source's
// new HEAD against this, so only genuinely new commits are processed.
export interface SourceSyncState {
  flowId?: string;
  sourceId: string;
  lastSha: string;
  lastCheckedAt: string;
}

export interface SourceChangeFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "other";
  diff: string;
}

// A knowledge-base document the change *might* affect — retrieved from the KB and
// handed to the model as the only documents it is allowed to edit.
export interface SourceSyncCandidateDocument {
  path: string;
  content: string;
}

export interface SourceChangeSyncJobInput {
  flowId?: string;
  destinationId?: string;
  sourceId: string;
  sourceName: string;
  fromSha: string;
  toSha: string;
  changes: SourceChangeFile[];
  candidateDocuments: SourceSyncCandidateDocument[];
  expectedOutput: "crunch_plan";
}

export type SourceChangeSyncJobOutput = CrunchPlan;

export interface SourceSyncRun {
  id: string;
  flowId?: string;
  destinationId?: string;
  sourceId: string;
  trigger: SourceSyncRunTrigger;
  status: SourceSyncRunStatus;
  jobId?: string;
  plan?: CrunchPlan;
  // The constrained changeset the API derived from the plan at gather time (only
  // writes to candidate documents). Persisted so the publish job can fetch it
  // without re-deriving the candidate set. Absent on skipped/failed runs.
  changeset?: ChangesetChange[];
  error?: string;
  fromSha?: string;
  toSha: string;
  changedFileCount: number;
  candidateCount: number;
  publication?: ProposalPublication;
  createdAt: string;
  completedAt?: string;
}

// One fix-patrol tick: which documents in a flow were checked and when. `selected`
// is the batch the rolling cursor chose this run; `universeCount` is how many
// documents the flow had to choose from. No status field — a patrol tick is atomic
// (select → stamp → record), never pending.
// A verify-lens result recorded on a patrol run: the document, the claims the
// sources could not substantiate, and what the reconcile gate decided to do with
// the emitted intent. `intoProposalId` is set only when the gate folded it into an
// existing open PR.
export interface VerifyFinding {
  path: string;
  claims: UnprovableClaim[];
  decision: "open-new" | "fold" | "defer";
  intoProposalId?: string;
}

export interface PatrolRun {
  id: string;
  flowId?: string;
  trigger: "scheduled" | "manual";
  universeCount: number;
  selectedCount: number;
  selected: string[];
  // The verify-lens findings this tick produced (empty when every checked doc was
  // healthy or the patrol ran no lens).
  findings: VerifyFinding[];
  createdAt: string;
}

// Schedule for a generic background side-process (e.g. refreshing pull request
// status). Keyed by a stable task key from the server's task registry, so the
// Crunch page can drive any number of scheduled side-processes uniformly.
export interface ScheduledTaskSettings {
  key: string;
  enabled: boolean;
  cron: string;
}

// --- Watcher registry ------------------------------------------------------
// A watcher is busy while it runs a claimed job and idle while it polls for the
// next one; the API derives this from which lifecycle call last arrived.
export type WatcherStatus = "idle" | "busy";

// One connected watcher as the Jobs screen sees it. The watcher process makes
// itself distinct by appending a per-process uuid to its operator-set label
// (`<WATCHER_NAME>-<uuid>`), so horizontally-scaled replicas never collide on a
// single registry row. `name` is that full unique identifier; `capabilities`
// are the job kinds it advertised when it last claimed. Liveness is best-effort:
// the API records `lastSeenAt` on every claim/heartbeat and drops a watcher from
// the list once it has been silent past the active window (so a crashed watcher
// lingers at most that long), without any explicit deregistration.
export interface WatcherView {
  name: string;
  status: WatcherStatus;
  capabilities: string[];
  currentJobId?: string;
  lastSeenAt: string;
}

// --- Cron scheduling -------------------------------------------------------
// A small, dependency-free evaluator for standard 5-field cron expressions:
//   minute(0-59) hour(0-23) day-of-month(1-31) month(1-12) day-of-week(0-6)
// Supports "*", lists (a,b), ranges (a-b), and steps (*/n, a-b/n). Sunday is 0
// (7 is also accepted as Sunday). Times are evaluated in local time.
//
// Caveat: evaluation is in local wall-clock time and nextCronTime scans
// minute-by-minute, so around DST transitions a "skipped" local hour can be
// missed and a "repeated" local hour can match twice. Acceptable for the
// coarse maintenance schedules this drives; revisit if minute-precision
// correctness across DST is ever required.

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseCronField(field: string, min: number, max: number): Set<number> | undefined {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const stepMatch = /^(.+)\/(\d+)$/.exec(part);
    const rangePart = stepMatch ? stepMatch[1] : part;
    const step = stepMatch ? Number.parseInt(stepMatch[2], 10) : 1;
    if (step <= 0) {
      return undefined;
    }

    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else {
      const range = /^(\d+)-(\d+)$/.exec(rangePart);
      if (range) {
        lo = Number.parseInt(range[1], 10);
        hi = Number.parseInt(range[2], 10);
      } else if (/^\d+$/.test(rangePart)) {
        lo = Number.parseInt(rangePart, 10);
        hi = lo;
      } else {
        return undefined;
      }
    }

    if (Number.isNaN(lo) || Number.isNaN(hi) || lo < min || hi > max || lo > hi) {
      return undefined;
    }
    for (let value = lo; value <= hi; value += step) {
      values.add(value);
    }
  }
  return values.size > 0 ? values : undefined;
}

function parseCronExpression(expr: string): CronFields | undefined {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return undefined;
  }

  const minute = parseCronField(parts[0], 0, 59);
  const hour = parseCronField(parts[1], 0, 23);
  const dayOfMonth = parseCronField(parts[2], 1, 31);
  const month = parseCronField(parts[3], 1, 12);
  const dayOfWeek = parseCronField(parts[4].replace(/7/g, "0"), 0, 6);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    return undefined;
  }

  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*"
  };
}

export function isValidCron(expr: string): boolean {
  return parseCronExpression(expr) !== undefined;
}

function cronMatches(fields: CronFields, date: Date): boolean {
  if (!fields.minute.has(date.getMinutes())) {
    return false;
  }
  if (!fields.hour.has(date.getHours())) {
    return false;
  }
  if (!fields.month.has(date.getMonth() + 1)) {
    return false;
  }

  const domMatch = fields.dayOfMonth.has(date.getDate());
  const dowMatch = fields.dayOfWeek.has(date.getDay());
  // Vixie-cron rule: when both day-of-month and day-of-week are restricted, a
  // match on either one counts; otherwise both must match.
  if (fields.domRestricted && fields.dowRestricted) {
    return domMatch || dowMatch;
  }
  return domMatch && dowMatch;
}

// The next minute that matches `expr`, strictly after `from`, or undefined if the
// expression is invalid (or — practically never — has no match within a year).
export function nextCronTime(expr: string, from: Date): Date | undefined {
  const fields = parseCronExpression(expr);
  if (!fields) {
    return undefined;
  }

  const candidate = new Date(from.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const maxIterations = 366 * 24 * 60;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (cronMatches(fields, candidate)) {
      return new Date(candidate.getTime());
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return undefined;
}

// Multi-file branch publish, used by Crunch (and any future change that touches
// more than one document at once). A change with `delete: true` removes the
// file; otherwise `content` is written.
export interface ChangesetChange {
  path: string;
  content?: string;
  delete?: boolean;
}

export interface PublishChangesetRequest {
  repository: RepositoryRef;
  branchName: string;
  title: string;
  changes: ChangesetChange[];
}

