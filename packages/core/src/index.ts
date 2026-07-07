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
  /** The section's retrieval relevance in [0,1]; higher is a stronger match. */
  relevance: number;
}

// When the router cannot decide which flow a question belongs to (and the caller
// asked for "auto" rather than naming a flow), the answer is withheld and the
// caller is asked to pick one of these flows and re-ask. Carried on the answer
// output / result so the UI and MCP can surface the choice.
export interface FlowSelectionRequired {
  availableFlows: Array<{ id: string; name: string }>;
}

// When a flow is picked (routed or pinned) but the question is unrelated to that
// knowledge area — e.g. a question about cats asked of a product flow — the flow
// rejects it rather than answering. Distinct from a knowledge gap ("the KB should
// cover this but doesn't"): an off-topic question raises NO gaps, so it never
// clusters or drafts a proposal. Carried on the answer output/result so the UI and
// MCP can surface the rejection distinctly from a low-confidence answer.
export interface OutOfScope {
  reason?: string;
}

export interface AnswerResult {
  answer: string;
  confidence: Confidence;
  citations: Citation[];
  // A single question can expose several distinct knowledge gaps (e.g. asking
  // "how do I set this up with React so I can export dashboards?" is two gaps).
  // Each is tracked separately so it can cluster and become its own proposal.
  gaps?: KnowledgeGapSignal[];
  // Present (with answer withheld, confidence "unknown") when "auto" routing could
  // not determine a flow; the caller must re-ask naming one of these flows.
  flowSelectionRequired?: FlowSelectionRequired;
  // Present (with confidence "unknown", no gaps) when the picked flow judged the
  // question off-topic for its knowledge area and declined to answer.
  outOfScope?: OutOfScope;
  // How the watcher produced this answer — recorded so the console can explain an
  // answer (searches run, verification outcome) the way Schedules explains a run.
  trace?: AnswerTrace;
}

// One follow-up search the model requested during the agentic answer loop. An
// empty search (resultCount 0) is what grounds a followup gap, so the trace makes
// "why was no gap raised?" answerable: either no search ran, or every search hit.
export interface AnswerTraceSearch {
  query: string;
  resultCount: number;
  // 1-based search round the query ran in (several queries can share a round).
  round: number;
}

// The audit trail of one answer_question run, assembled by the watcher and stored
// with the question log. Every field reflects what actually happened in the loop —
// nothing here is model-self-reported except the routing confidence.
export interface AnswerTrace {
  routing: {
    // "requested" = caller pinned the flow; "routed" = a router picked it;
    // "unscoped" = routing infrastructure failed and the answer ran unscoped;
    // "unknown" = routing abstained and flow selection was requested instead.
    mode: "requested" | "routed" | "unscoped" | "unknown";
    flowId?: string;
    confidence?: Confidence;
    // Which router decided a "routed" outcome: "embedding" = the cheap cosine
    // similarity router; "chat" = the fallback chat completion. Absent for the
    // other modes (no router "decided" a flow).
    method?: "embedding" | "chat";
  };
  // Sections the seed retrieval (the question itself) returned.
  seedSectionCount: number;
  searches: AnswerTraceSearch[];
  // Deduped size of the context pool the final answer drew from.
  poolSectionCount: number;
  // True when the loop hit its round/pool cap and forced a final answer.
  answerForced: boolean;
  // Whether the model's final reply honoured the structured-answer JSON contract.
  // "unstructured" means the raw text shipped and confidence was forced low.
  // Absent when no answer was drafted at all (flow selection was requested).
  answerContract?: "structured" | "unstructured";
  verification: {
    // "grounded" = every claim checked out; "claims_stripped" = unsupported claims
    // were removed and the answer downgraded; "verdict_unparseable" = the verifier
    // reply was unusable and the drafted answer shipped as-is (fail open);
    // "skipped" = the check did not run (see skipReason).
    status: "grounded" | "claims_stripped" | "verdict_unparseable" | "skipped";
    skipReason?: "low_confidence" | "no_sections" | "flow_selection_required" | "out_of_scope";
    unsupportedClaims?: string[];
  };
}

export interface KnowledgeGapSignal {
  summary: string;
  question: string;
  confidence: Confidence;
  citedSectionIds: string[];
  // How this gap was raised. "auto" = the question went essentially unanswered;
  // "followup" = a well-answered question still lacked supporting material the
  // model searched for and could not find; "manual" = flagged by an admin.
  source: QuestionGapSource;
}

// Prefix of the synthesised gap summary a live answer emits when the flow flagged
// a knowledge gap (or retrieval was empty) but the model named no specific gap
// topics: it echoes the raw question ("No sufficient source material found for:
// <question>") rather than describing a topic. Owned here as one source of truth
// so the watcher builds it and the API recognises it identically. Such a summary
// records the miss but is a poor proposal seed — it restates the question and
// never merges with a sibling wording — so the API drops it before it becomes a
// gap row, and it never seeds a cluster or proposal.
export const NO_SOURCE_MATERIAL_GAP_PREFIX = "No sufficient source material found for:";

// "auto"/"manual"/"followup" are the sources a live answer can raise (the model
// or an admin). "verification" is raised server-side after a merged proposal
// fails gap-closure verification: the triggering question was re-asked and the
// merged doc still did not answer it. It never comes from a provider — the
// answer_question output schema stays narrow to the first three. "Parked,
// awaiting a human" (repeated verification failures past the retry cap) is NOT a
// source — it is the `parkedAt` state on a verification gap (see QuestionGap).
export type QuestionGapSource = "auto" | "manual" | "followup" | "verification";

export interface QuestionGap {
  summary: string;
  source: QuestionGapSource;
  // Verification detail carried when a failed gap-closure check reopens this gap:
  // what merged, the re-asked answer, and why it is still weak — so a re-drafted
  // proposal can see why it is being resubmitted. Only set for verification gaps.
  note?: string;
  // Set when a merged proposal closes this gap. A resolved gap is retained for
  // audit but no longer surfaces as a candidate.
  resolvedAt?: string;
  resolvedByProposalId?: string;
  // Set when the gap reconciler judged this gap off-topic for the knowledge base
  // (unrelated to the source knowledge) and dismissed it permanently. A dismissed
  // gap is retained for audit but never surfaces as a candidate or clusters again.
  dismissedAt?: string;
  dismissedReason?: string;
  // Set when a verification gap fails gap-closure past the retry cap: the whole
  // question is "parked", awaiting a human. First-class escalation STATE (not a
  // source): while a live parked row exists (parkedAt set, not resolved/dismissed)
  // the whole question is excluded from gap candidacy and clustering. A human
  // retry/dismiss settles it (see the parked-gap human workflow, issue #158).
  parkedAt?: string;
  parkedReason?: string;
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
  // Why this question log exists. "live" (default) is a real user/admin question.
  // "verification" is a gap-closure re-ask synthesised by verifyGapClosure: it
  // must NOT re-enter gap candidacy, the questions list, or gap clustering — its
  // answer's gap signals are the merged doc's shortfall, not a fresh gap, and
  // treating it as live would auto-redraft the very gap that was just parked
  // (see docs/question-logging.md, issue #154).
  purpose?: "live" | "verification";
}

export interface QuestionLogInput {
  question: string;
  chatProvider: string;
  answer?: AnswerResult;
  retrievedSectionIds: string[];
  flowId?: string;
  purpose?: "live" | "verification";
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

// A question parked awaiting a human (its verification gap failed closure past
// the retry cap). Surfaced by the parked-questions listing so an operator can see
// the diagnostic note and act — retry (re-admit to the pipeline) or dismiss
// (abandon the topic). See the parked-gap human workflow (issue #158).
export interface ParkedQuestion {
  questionId: string;
  question: string;
  flowId?: string;
  summary: string;
  note?: string;
  parkedAt: string;
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

// Settled statuses: the proposal's work is done (merged), declined (rejected), or
// folded into another proposal (superseded). These are hidden from the default
// inbox — like an archive — but stay fetchable via an explicit status filter so
// history is never lost. Derived here once so the proposal stores don't each
// hand-maintain the literal list and drift (which once left superseded proposals
// stuck visible in the UI with no action).
export const TERMINAL_PROPOSAL_STATUSES: ReadonlyArray<ProposalStatus> = ["merged", "rejected", "superseded"];

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
  // the watcher's refresh_flow_snapshot job. Absent until the PR has been polled (or
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
  // Computed by the API when serving proposals to the console (NOT persisted):
  // true when this proposal's destination is a local-git (file://) repository, so
  // the UI offers a real "Merge" instead of the hosted "Mark Merged".
  localGitDestination?: boolean;
  // The outcome of gap-closure verification, set after the proposal merged and its
  // triggering questions were re-asked. Absent until a verification has run.
  // 'verified_closed' = the merged doc now answers every triggering question;
  // 'reopened' = at least one is still weak (its gap was left open to re-draft);
  // 'needs_attention' = repeated verification failures, flagged for a human.
  closureStatus?: "verified_closed" | "reopened" | "needs_attention";
  // How many times this proposal's published PR has been auto-regenerated after
  // going stale (its base moved and the merge conflicted). Bounds the retry loop:
  // once it reaches the cap the proposal is surfaced for a human instead of
  // regenerating again. Absent/0 until the first regeneration.
  regenerationCount?: number;
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

// --- Flow snapshots ---------------------------------------------------------
// The downloaded state the fetch job assembles for one flow and the api store
// persists, so the reconciler reads it instead of polling the host live. The web
// console reads the same shapes back over /snapshots (as FlowSnapshotView), so the
// canonical definitions live here rather than being mirrored by hand in the web.

// A flow's proposal as captured in a snapshot — just the fields the processor and
// a human reviewer need, not the full markdown body.
export interface SnapshotProposal {
  id: string;
  title?: string;
  status: Proposal["status"];
  gapClusterId?: string;
  pullRequestUrl?: string;
}

// The polled state of one of this flow's open pull requests. `etag` and
// `checkedAt` back the cache: a later refresh can issue a conditional request and
// keep the prior state on a 304 instead of re-reading the whole PR.
export interface SnapshotPullRequest {
  proposalId: string;
  url: string;
  merged: boolean;
  state: "open" | "closed" | "unknown";
  // The latest review decision the watcher reported for this PR, when known.
  reviewDecision?: ReviewDecision;
  etag?: string;
  checkedAt: string;
}

// Everything the fetch job downloads for one flow: the inputs the reconciler would
// otherwise gather live (gaps, proposals) plus the externally-polled PR state. This
// is the persisted store shape; FlowSnapshotView adds the flow's human label.
export interface FlowSnapshot {
  flowId?: string;
  takenAt: string;
  catalogRevision: number;
  gaps: GapCandidate[];
  proposals: SnapshotProposal[];
  pullRequests: SnapshotPullRequest[];
}

// A snapshot enriched with its flow's human label — the shape the api serves over
// /snapshots and the web console renders. The default flow has no flowId, so the
// api supplies a stable label.
export interface FlowSnapshotView extends FlowSnapshot {
  flowName: string;
}

// --- Reconciliation decisions -----------------------------------------------
// A single clustering decision the reconciler made while reshaping a flow's gap
// clusters: a proposed merge, split, or dismissal, the model's rationale for it,
// and whether the critic confirmed and the reconciler applied it. Persisted so a
// reviewer can see WHY the clustering changed, not just its result — previously
// this lived only in console logs.
export interface ReconciliationDecisionRecord {
  id: string;
  // The flow the reshape belongs to; undefined for the un-routed/default flow.
  flowId?: string;
  // "dismiss" = the cluster was judged off-topic for the knowledge base and dropped
  // permanently (its gaps stamped dismissed) rather than merged or split.
  kind: "merge" | "split" | "dismiss";
  // The proposing model's rationale for the merge/split/dismissal.
  rationale: string;
  // The critic's verdict on the proposal.
  confirmed: boolean;
  // Whether the reconciler went on to apply it (only confirmed changes are applied).
  applied: boolean;
  // The clusters involved: every merged cluster, or the single cluster being split.
  clusterIds: string[];
  createdAt: string;
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
  // When "json", the caller expects a JSON reply and API-backed providers ask the
  // model to emit syntactically valid JSON (OpenAI/Azure response_format json_object).
  // This closes the class of failures where a model embeds an unescaped quote in a
  // JSON string and the whole reply fails to parse. CLI providers cannot enforce it
  // and rely on the prompt (which already demands JSON) instead.
  responseFormat?: "json";
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
  // The flow the caller pinned the question to. When set, the watcher skips
  // routing and uses this flow directly. Absent means "auto" — route as usual.
  // Validated against the configured flows at the API boundary before enqueue.
  requestedFlowId?: string;
  expectedOutput: "answer_result";
}

export interface AnswerQuestionJobOutput {
  answer: string;
  confidence: Confidence;
  citations: Citation[];
  gaps?: KnowledgeGapSignal[];
  // The flow the watcher routed the question to, recorded on completion so the
  // question log reflects which flow answered. Absent when no flow was chosen.
  flowId?: string;
  // Present (answer withheld, confidence "unknown") when "auto" routing could not
  // determine a flow; the caller must re-ask naming one of these flows.
  flowSelectionRequired?: FlowSelectionRequired;
  // Present (confidence "unknown", no gaps) when the picked flow judged the
  // question off-topic for its knowledge area. No gap is raised for it.
  outOfScope?: OutOfScope;
  // The watcher's audit trail for this answer (routing, searches, verification).
  // Persisted with the question log so the console can explain the answer.
  trace?: AnswerTrace;
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
  // Verification detail for gaps being re-drafted after a previous proposal
  // merged but failed its gap-closure check (the `note` on a verification /
  // needs_attention gap): what merged, the re-asked answer, and why it was still
  // weak. Present only on a resubmission, so the drafter can see why its earlier
  // attempt did not close the gap and address the specific shortfall this time.
  resubmissionNotes?: string[];
  // References to the flow's configured sources the drafter is grounded in — the
  // executing agent explores these checkouts directly (see the source-agentic
  // grounding spec). Replaces the old inline sourceContext file sample. git/local
  // resolve to traversable workspaces on the watcher; internet/agent render as
  // prompt notes only. Empty when the flow has no configured sources.
  sources: SourceDescriptor[];
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
  // When set, this draft is a REGENERATION of an already-published proposal whose
  // PR went stale (its base moved and the merge now conflicts). The completion
  // handler updates the existing proposal in place — keeping its id, title, branch,
  // and open PR — and re-publishes from the fresh base, instead of creating a new
  // proposal. Absent on a first-time draft.
  regenerateProposalId?: string;
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

// One claim in a knowledge-base document the verify lens could not substantiate
// against the document's source material, with the model's reason.
export interface UnprovableClaim {
  claim: string;
  reason: string;
}

// Input to the verify_document AI job: one knowledge-base document plus references
// to the flow's configured sources to check it against. The executing agent
// explores those checkouts directly (see the source-agentic grounding spec);
// git/local descriptors resolve to read-only workspaces on the watcher, while
// internet/agent render as prompt notes only. `provider` is added at enqueue
// (see @magpie/jobs).
export interface VerifyDocumentJobInput {
  path: string;
  content: string;
  sources: SourceDescriptor[];
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
  // References to the flow's configured sources the repair/expansion is grounded
  // in — the executing agent explores these checkouts directly (see
  // VerifyDocumentJobInput). Replaces the old shared-corpus reference.
  sources: SourceDescriptor[];
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

export interface ImproveDocumentJobInput {
  path: string;
  content: string;
  // References to the flow's configured sources the repair/expansion is grounded
  // in — the executing agent explores these checkouts directly (see
  // VerifyDocumentJobInput). Replaces the old shared-corpus reference.
  sources: SourceDescriptor[];
  destinationId?: string;
  flowId?: string;
}

export interface ImproveDocumentJobOutput {
  improved: boolean;
  markdown?: string;
  rationale: string;
}

export interface DraftMarkdownProposalJobOutput {
  title: string;
  targetPath: string;
  markdown: string;
  rationale: string;
}

// One unit of flow seeding: a document to author, described by what it should
// cover. `coverage` plays the role gap summaries play on the demand path;
// everything else is optional shaping. Shared by the seed executor and (v2) the
// outline generator.
export interface SeedItem {
  title?: string;
  targetPath?: string;
  coverage: string[];
  questions?: string[];
}

// A reference to one of a flow's configured sources, carried on source-grounded
// job inputs INSTEAD of inline file content. git/local descriptors resolve to a
// traversable workspace on the watcher (see the source-agentic grounding spec);
// internet/agent render as prompt notes only.
export type SourceDescriptor =
  | { id: string; name: string; kind: "git"; url: string; subpath?: string }
  | { id: string; name: string; kind: "local"; path: string; subpath?: string }
  | { id: string; name: string; kind: "internet"; url?: string }
  | { id: string; name: string; kind: "agent" };

// Input to the draft_seed_document AI job: author a NEW document covering
// `coverage`, grounded in the source repositories named by `sources`, bypassing
// the demand-driven gap pipeline. `provider` is added at enqueue (see @magpie/jobs).
export interface DraftSeedDocumentJobInput {
  flowId: string;
  title?: string;
  targetPath?: string;
  coverage: string[];
  questions?: string[];
  sources: SourceDescriptor[];
  destinationId?: string;
}

// Output of draft_seed_document: the authored document plus a short rationale.
export interface DraftSeedDocumentJobOutput {
  title: string;
  targetPath: string;
  markdown: string;
  rationale: string;
}

// A section of an existing flow document, surfaced to the outline generator as
// retrieval grounding so it proposes docs that fit the current structure and do
// not restate what the knowledge base already covers.
export interface ExistingDocumentContext {
  path: string;
  heading: string;
  excerpt: string;
}

// Input to the outline_flow_seed AI job: propose a SeedItem[] (a doc list, titles +
// coverage) for `topic`, grounded in the flow's existing docs. It only PROPOSES —
// its output feeds the v1 seed endpoint after human review. `provider` is added at
// enqueue (see @magpie/jobs).
export interface OutlineFlowSeedJobInput {
  flowId: string;
  topic: string;
  notes?: string;
  existingDocuments: ExistingDocumentContext[];
  persona?: string;
}

// Output of outline_flow_seed: the proposed seed items plus a short rationale for
// the overall shape. The items are edited by a human before being seeded.
export interface OutlineFlowSeedJobOutput {
  items: SeedItem[];
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
  // When true, re-cut the branch from the CURRENT default-base tip (not the
  // existing branch tip) and force-push. Used to regenerate a stale PR: the base
  // moved under the branch, so rewriting the file on top of the old tip would leave
  // the conflict; re-basing on the fresh tip resolves it. Absent = normal publish
  // (create fresh, or fast-forward an existing bot-owned branch).
  regenerate?: boolean;
}

export interface PublishProposalBranchResponse {
  branchName: string;
  commitSha: string;
  remoteUrl?: string;
  // True when the proposal's content was byte-identical to what the base already
  // carries on a fresh branch create, so nothing was published (no branch pushed).
  // The generated doc is a no-op — autonomous generation can emit one — and the
  // caller settles the proposal as superseded rather than treating it as a failure.
  noChange?: boolean;
}

// ---------------------------------------------------------------------------
// Maintenance plan — a multi-file write/delete changeset
//
// Some maintenance passes (currently source-change sync) restructure several
// knowledge-base documents at once rather than editing a single Markdown file.
// They express the change as a MaintenancePlan: a list of operations that
// consolidate, split, or rewrite documents, which the API flattens into a
// changeset and lands on a review branch.
// ---------------------------------------------------------------------------

export type MaintenanceOperationKind = "consolidate" | "split" | "rewrite";

export interface MaintenanceFileWrite {
  path: string;
  content: string;
}

export interface MaintenanceOperation {
  kind: MaintenanceOperationKind;
  title: string;
  reason: string;
  // Existing document paths this operation reorganizes (read and usually
  // replaced). Kept for the reviewer to see what was touched.
  sources: string[];
  writes: MaintenanceFileWrite[];
  deletes: string[];
}

export interface MaintenancePlan {
  summary: string;
  operations: MaintenanceOperation[];
  rationale: string;
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
// reality — landing the result on a review branch. The plan reuses MaintenancePlan:
// the output is the same multi-file write/delete changeset.
// ---------------------------------------------------------------------------

export type SourceSyncRunTrigger = "scheduled" | "manual";

// "skipped" records a detected source change that needed no KB edit (nothing in
// the KB matched it, or the model returned an empty plan) — kept for the operator
// to see that the change was considered.
export type SourceSyncRunStatus = "running" | "completed" | "failed" | "skipped";

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
  // The TRUE number of files the commit range touched. When a pathological commit
  // exceeds the downstream cap, `changes` carries only the first N (deterministic
  // order) while this records the real magnitude — so nothing is silently lost.
  totalChangedFileCount?: number;
  // True when `changes` was capped: the model is seeing a representative subset of a
  // larger commit, not the whole thing. Optional/back-compatible with older inputs.
  changedFilesTruncated?: boolean;
  candidateDocuments: SourceSyncCandidateDocument[];
  expectedOutput: "maintenance_plan";
}

export type SourceChangeSyncJobOutput = MaintenancePlan;

export interface SourceSyncRun {
  id: string;
  flowId?: string;
  destinationId?: string;
  sourceId: string;
  trigger: SourceSyncRunTrigger;
  status: SourceSyncRunStatus;
  jobId?: string;
  plan?: MaintenancePlan;
  // The constrained changeset the API derived from the plan at gather time (only
  // writes to candidate documents). Persisted so the publish job can fetch it
  // without re-deriving the candidate set. Absent on skipped/failed runs.
  changeset?: ChangesetChange[];
  error?: string;
  fromSha?: string;
  toSha: string;
  changedFileCount: number;
  candidateCount: number;
  createdAt: string;
  completedAt?: string;
}

// A verify-lens result recorded on a patrol run: the document, the claims the
// sources could not substantiate, and what the reconcile gate decided to do with
// the emitted intent. `intoProposalId` is set only when the gate folded it into an
// existing open PR.

export const MAINTENANCE_LENSES = ["gap", "source-sync", "verify", "dedupe", "split", "complete"] as const;
export type MaintenanceLens = (typeof MAINTENANCE_LENSES)[number];

export interface ChangeIntent {
  lens: MaintenanceLens;
  flowId?: string;
  targets: string[];
  evidence: string[];
  rationale: string;
}

export interface ChangeIntentTraceCandidate {
  proposalId: string;
  targets: string[];
  touchable: boolean;
  overlapTargets: string[];
}

export interface ChangeIntentTraceOutcome {
  proposalId?: string;
  proposalTitle?: string;
  proposalStatus?: Proposal["status"];
  pullRequestUrl?: string;
  foldJobId?: string;
  reason?: string;
}

export type ChangeIntentTraceDecision =
  | { kind: "open-new" }
  | { kind: "fold"; intoProposalId: string }
  | { kind: "defer"; behindProposalId: string }
  | { kind: "drop"; reason: string };

export interface ChangeIntentTrace {
  createdAt: string;
  intent: ChangeIntent;
  decision: ChangeIntentTraceDecision;
  candidatePullRequests: ChangeIntentTraceCandidate[];
  outcome?: ChangeIntentTraceOutcome;
}

export interface VerifyFinding {
  path: string;
  claims: UnprovableClaim[];
  decision: "open-new" | "fold" | "defer";
  intoProposalId?: string;
}

// ---------------------------------------------------------------------------
// Maintenance-run audit — one durable record per scheduled-task execution
//
// Every scheduled maintenance task (the patrols, gaps→PR, and later source-sync)
// writes a MaintenanceRun when it runs: a uniform, queryable audit of WHAT ran,
// for which flow, and how it turned out — including no-op and failed ticks. It is
// an execution audit only; the downstream proposal's publish/merge lifecycle lives
// on the Proposal, not here. The task-specific payload goes in `details` so the
// shared shape stays generic.
// ---------------------------------------------------------------------------

export type MaintenanceTaskType = "correctness_patrol" | "editorial_patrol" | "process_gaps_to_pull_requests";

export type MaintenanceRunStatus = "running" | "completed" | "failed";

export interface MaintenanceRun {
  id: string;
  taskType: MaintenanceTaskType;
  flowId?: string;
  trigger: "scheduled" | "manual";
  status: MaintenanceRunStatus;
  // One-line human summary, e.g. "checked 5/40 docs · 1 finding".
  summary: string;
  error?: string;
  // Task-specific payload (JSONB in Postgres). Open by design so each task records
  // what it has without widening the shared shape.
  details: Record<string, unknown>;
  startedAt: string;
  completedAt?: string;
}

export type NewMaintenanceRun = Omit<MaintenanceRun, "id" | "startedAt"> & { startedAt?: string };

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

// ---------------------------------------------------------------------------
// Insights / charts
//
// Response shapes for the /insights/* aggregation endpoints, consumed by the
// web console's Insights page. See docs/insights-charts.md for the per-chart
// operator questions and source tables.
// ---------------------------------------------------------------------------

// The time-bucket granularity for a time-series insight. Maps 1:1 to Postgres
// date_trunc units.
export type InsightsBucketUnit = "day" | "week" | "month";

// One time bucket of the open-gap backlog trend. `openTotal` is the cumulative
// number of gaps still open at the end of the bucket; the other counts are the
// transitions that happened within the bucket.
export interface GapBacklogBucket {
  bucketStart: string; // ISO timestamp of the bucket's start
  opened: number;
  resolved: number;
  dismissed: number;
  parked: number;
  openTotal: number;
}

// One time bucket of job throughput, split by terminal/active state.
export interface JobThroughputBucket {
  bucketStart: string;
  completed: number;
  failed: number;
  active: number;
  retry: number;
}

// The branching question-journey Sankey. A directed graph of the path a question
// takes — from being asked (and how confidently it was answered) through gaps,
// clusters, proposals, and merge/verification outcomes — where each link's value
// is a real count and the branches show where volume leaks at each stage.
//
// The unit of flow shifts across the graph: question → gap → proposal. This is
// inherent (one question can raise many gaps; one cluster can yield many
// proposals) and is labelled on the chart. Each segment is internally conserved:
// widths within a segment sum consistently; only the marked segment boundaries
// change unit.
export type JourneySegment = "answer" | "gap" | "proposal" | "verify";

// One node of the journey graph. `key` is a stable identifier used as a link
// endpoint; `segment` drives colouring and the unit-boundary captions.
export interface JourneyNode {
  key: string;
  label: string;
  segment: JourneySegment;
}

// One directed link, sized by `value` (a real count). `source`/`target` are node
// keys. Only links with value > 0 are emitted, so empty segments collapse.
export interface JourneyLink {
  source: string;
  target: string;
  value: number;
}

// The full journey Sankey payload: draw-order nodes plus positive-value links.
// Only nodes referenced by at least one link are included.
export interface JourneySankey {
  nodes: JourneyNode[];
  links: JourneyLink[];
}

// One bar of the answer-latency histogram (C4). Buckets completed answer_question
// jobs by how long they took end-to-end (queued → completed) into fixed latency
// ranges. `from`/`to` are the range bounds in seconds (`to` null on the open-ended
// top bucket); `count` is how many completed answers fell in the range.
export interface LatencyBin {
  label: string;
  from: number;
  to: number | null;
  count: number;
}

// The closed-vs-open split of gap-closure verification outcomes (C5). `closed` =
// verdict 'closed' (the merged doc now answers the re-asked question); `stillOpen`
// = verdict 'still_open'. Used both as the overall total and per time bucket.
export interface VerificationSummary {
  closed: number;
  stillOpen: number;
}

// One time bucket of the verification-success trend (C5), tagged with its bucket
// start so the client can plot success rate over time.
export interface VerificationBucket extends VerificationSummary {
  bucketStart: string;
}

// One bar of the job-error breakdown (C6): a labelled slice of failed pg-boss jobs
// and how many landed under it. `key` is either an error category (provider /
// validation / timeout / …) or a job type, depending on which dimension the bar
// belongs to. Failed rows are unioned across pg-boss's live `job` and `archive`
// tables so finished failures stay in the history.
export interface JobErrorBreakdown {
  key: string;
  count: number;
}

// Review-cycle compliance of the active knowledge base (C7). `documents` splits
// docs that carry a review cadence (`review_cycle_days`) by how their next-review
// date compares to today; `sources` splits synced sources by how recently they
// were last checked. A point-in-time snapshot, not a time series.
export interface DocumentFreshness {
  fresh: number; // next review is more than the soon-window away
  due: number; // next review falls within the soon-window
  overdue: number; // past its next-review date (or never verified)
}

export interface SourceFreshness {
  fresh: number; // synced within the stale-window
  stale: number; // not synced for longer than the stale-window
}

export interface FreshnessSummary {
  documents: DocumentFreshness;
  sources: SourceFreshness;
}

// Impact of maintenance patrols and the gap→PR reconciler over the window (C8),
// one row per `maintenance_runs.task_type`. `findings` sums the verify-lens
// findings patrol runs recorded (`details.findings`); `proposals` sums the
// proposals the gap→PR runs drafted (`details.proposalsDrafted`). A task type only
// contributes to the field its runs actually record; the other stays zero.
export interface PatrolImpact {
  taskType: string;
  runs: number;
  findings: number;
  proposals: number;
}
