import type { ChatProvider } from "@magpie/core";
import type { JobType, JobView } from "@magpie/jobs";
import {
  JOB_TYPES,
  jobDefinition,
  answerQuestionInputSchema,
  reconcileGapClustersInputSchema,
  reconcileGapClustersOutputSchema
} from "@magpie/jobs";
import {
  ANSWER_QUESTION,
  GAP_RECONCILE_CRITIC,
  GAP_RECONCILE_PROPOSE,
  JOB_RUNNER_SYSTEM,
  VERIFY_ANSWER,
  withPersona
} from "@magpie/prompts";
import { routeQuestionToFlow, type FlowRoute, type RoutableFlow } from "@magpie/retrieval";
import type { z } from "zod";
import type { RetrievedSection, WatcherApi } from "../http-client.js";
import { logger } from "../logger.js";
import {
  applyGroundingVerdict,
  buildAnswerOutput,
  buildFlowSelectionRequiredOutput,
  buildPrompt,
  extractJson,
  parseGroundingVerdict,
  parseJobOutput,
  withVerification,
  type AnswerLoopTrace,
  type AnswerOutput
} from "../job-prompts.js";
import type { AnswerTrace } from "@magpie/core";

export interface GenerativeJobOptions {
  job: JobView;
  model: ChatProvider;
  api: WatcherApi;
  signal: AbortSignal;
  buildPromptOverride?: (job: JobView) => string;
}

export const PROVIDER_JOB_TYPES: ReadonlySet<JobType> = new Set(
  JOB_TYPES.filter((type) => {
    try {
      return jobDefinition(type).requiredCapability({ provider: "codex" }) === "codex";
    } catch {
      return false;
    }
  })
);

type ReconcileOutput = z.infer<typeof reconcileGapClustersOutputSchema>;
type ReconcileInput = z.infer<typeof reconcileGapClustersInputSchema>;
type ProposedMerge = { clusterIds: string[]; rationale: string };
type ProposedSplit = { clusterId: string; children: Array<{ gapIds: string[] }>; rationale: string };
type ProposedDismissal = { clusterId: string; rationale: string };

export async function runGenerativeJob(options: GenerativeJobOptions): Promise<unknown> {
  const { job } = options;
  if (job.type === "answer_question") {
    return answer(options);
  }
  if (job.type === "reconcile_gap_clusters") {
    return reconcileGapClusters(options);
  }

  const prompt = options.buildPromptOverride ? options.buildPromptOverride(job) : buildPrompt(job);
  const response = await options.model.complete({
    system: JOB_RUNNER_SYSTEM.instructions,
    messages: [{ role: "user", content: prompt }],
    signal: options.signal
  });
  return parseJobOutput(job, response.content);
}

// The agentic answer loop. After routing + a seed retrieval the model assesses
// what it has and may request follow-up searches (within the same flow scope)
// before answering, so an answer can pull in closely related material rather than
// being capped at one fixed top-K grab. Bounded by MAX_SEARCH_ROUNDS and
// MAX_POOL_SECTIONS so a job can never search unboundedly. Queries whose
// retrieval comes back empty are recorded so the model's followup gaps can be
// grounded to searches that genuinely found nothing.
const MAX_SEARCH_ROUNDS = 3;
const MAX_POOL_SECTIONS = 15;

async function answer({ job, model, api, signal }: GenerativeJobOptions): Promise<unknown> {
  const input = answerQuestionInputSchema.parse(job.input);
  const flows: RoutableFlow[] = input.flows.map((flow) => ({
    id: flow.id,
    name: flow.name,
    ...(flow.persona ? { persona: flow.persona } : {})
  }));

  const route = await resolveFlow(input.requestedFlowId, input.question, flows, model, job.id);

  // The audit trail of this run, persisted with the question log so the console
  // can explain the answer: how routing went, what was searched (and what came
  // back empty), and — filled in later — whether grounding verification ran.
  const routing: AnswerTrace["routing"] = {
    mode:
      input.requestedFlowId ? "requested"
      : route.status === "routed" ? "routed"
      : route.status === "unroutable" ? "unscoped"
      : "unknown",
    ...(route.status === "routed" ? { flowId: route.flowId, confidence: route.confidence } : {})
  };

  // "auto" routing could not pick a flow: withhold the answer and ask the caller
  // to choose one of the configured flows and re-ask.
  if (route.status === "unknown") {
    logger.debug({ jobId: job.id }, `answer_question[${job.id}]: routing unknown; requesting flow selection`);
    return buildFlowSelectionRequiredOutput(flows, {
      routing,
      seedSectionCount: 0,
      searches: [],
      poolSectionCount: 0,
      answerForced: false
    });
  }

  const flowId = route.status === "routed" ? route.flowId : undefined;
  const routedFlow = flowId ? flows.find((flow) => flow.id === flowId) : undefined;
  const system = withPersona(ANSWER_QUESTION.instructions, routedFlow?.persona);

  // Deduped accumulator (sectionId -> section) plus the set of follow-up queries
  // that returned nothing above the relevance floor.
  const pool = new Map<string, RetrievedSection>();
  const unsatisfiedSearches = new Set<string>();

  logger.debug({ jobId: job.id, flowId: flowId ?? null }, `answer_question[${job.id}]: seeding retrieval for flow ${flowId ?? "(unscoped)"}`);
  const seed = await api.retrieve(input.question, flowId, undefined, signal);
  mergeSections(pool, seed);

  const searches: AnswerTrace["searches"] = [];
  const loopTrace = (answerForced: boolean): AnswerLoopTrace => ({
    routing,
    seedSectionCount: seed.length,
    searches: [...searches],
    poolSectionCount: pool.size,
    answerForced
  });

  for (let round = 0; round < MAX_SEARCH_ROUNDS && pool.size < MAX_POOL_SECTIONS; round += 1) {
    const content = await assess(model, system, input.question, [...pool.values()], false, signal);
    const assessment = parseAssessment(content);
    if (assessment.action === "answer") {
      logger.debug({ jobId: job.id, round, sectionCount: pool.size }, `answer_question[${job.id}]: answered after ${round} search round(s)`);
      const output = buildAnswerOutput(content, [...pool.values()], input.question, flowId, unsatisfiedSearches, loopTrace(false));
      return verifyAnswerGrounding(model, output, [...pool.values()], input.question, signal, job.id);
    }

    logger.debug({ jobId: job.id, round, queries: assessment.queries }, `answer_question[${job.id}]: running ${assessment.queries.length} follow-up search(es)`);
    for (const query of assessment.queries) {
      const results = await api.retrieve(query, flowId, undefined, signal);
      searches.push({ query, resultCount: results.length, round: round + 1 });
      if (results.length === 0) {
        unsatisfiedSearches.add(normalizeQuery(query));
      }
      mergeSections(pool, results);
      if (pool.size >= MAX_POOL_SECTIONS) {
        break;
      }
    }
  }

  // Ran out of search rounds or hit the section cap: force a final answer from
  // whatever has accumulated (no further searching allowed).
  logger.debug({ jobId: job.id, sectionCount: pool.size }, `answer_question[${job.id}]: forcing final answer from ${pool.size} section(s)`);
  const finalContent = await assess(model, system, input.question, [...pool.values()], true, signal);
  const output = buildAnswerOutput(finalContent, [...pool.values()], input.question, flowId, unsatisfiedSearches, loopTrace(true));
  return verifyAnswerGrounding(model, output, [...pool.values()], input.question, signal, job.id);
}

// Post-answer grounding check: a second model call reviews the drafted answer
// against the whole retrieved pool (not just the cited subset, so a claim backed
// by an uncited-but-retrieved section is not falsely flagged) and every
// unsupported claim is stripped, the answer downgraded to low, and the claims
// recorded as gaps. Only medium/high answers are checked — gap, out-of-scope, and
// already-low answers ship distrusted anyway. An unparseable verdict fails open
// (keeps the drafted answer) so a flaky verifier cannot downgrade every answer.
async function verifyAnswerGrounding(
  model: ChatProvider,
  output: AnswerOutput,
  sections: RetrievedSection[],
  question: string,
  signal: AbortSignal,
  jobId: string
): Promise<AnswerOutput> {
  if (output.outOfScope) {
    return withVerification(output, { status: "skipped", skipReason: "out_of_scope" });
  }
  if (sections.length === 0) {
    return withVerification(output, { status: "skipped", skipReason: "no_sections" });
  }
  if (output.confidence !== "high" && output.confidence !== "medium") {
    return withVerification(output, { status: "skipped", skipReason: "low_confidence" });
  }

  logger.debug({ jobId }, `answer_question[${jobId}]: verifying answer grounding against ${sections.length} section(s)`);
  const response = await model.complete({
    system: VERIFY_ANSWER.instructions,
    messages: [
      {
        role: "user",
        content: `Question:\n${question}\n\nAnswer under review:\n${output.answer}\n\nContext:\n${formatSectionContext(sections)}`
      }
    ],
    responseFormat: "json",
    signal
  });

  const verdict = parseGroundingVerdict(response.content);
  if (!verdict) {
    logger.warn({ jobId }, `answer_question[${jobId}]: grounding verdict was unparseable; keeping the drafted answer`);
    return withVerification(output, { status: "verdict_unparseable" });
  }
  if (verdict.grounded) {
    return withVerification(output, { status: "grounded" });
  }
  logger.info(
    { jobId, unsupportedClaimCount: verdict.unsupportedClaims.length, revised: Boolean(verdict.revisedAnswer) },
    `answer_question[${jobId}]: answer contained ${verdict.unsupportedClaims.length} unsupported claim(s); downgrading to low confidence`
  );
  return withVerification(applyGroundingVerdict(output, verdict, question), {
    status: "claims_stripped",
    unsupportedClaims: verdict.unsupportedClaims
  });
}

// One assess/answer turn. `forceAnswer` tells the model it has gathered enough and
// must answer now (used once search rounds are exhausted) so the loop always
// terminates on an answer rather than another search request.
async function assess(
  model: ChatProvider,
  system: string,
  question: string,
  sections: RetrievedSection[],
  forceAnswer: boolean,
  signal: AbortSignal
): Promise<string> {
  const context = sections.length > 0 ? formatSectionContext(sections) : "(no context retrieved yet)";
  const directive = forceAnswer
    ? "\n\nYou have gathered enough context. Answer now using only the context above; do not request more searches."
    : "";
  const response = await model.complete({
    system,
    messages: [{ role: "user", content: `Question:\n${question}\n\nContext:\n${context}${directive}` }],
    responseFormat: "json",
    signal
  });
  return response.content;
}

// Classifies an assess reply as a search request or an answer. Only a well-formed
// {"action":"search",...} with at least one non-empty query counts as a search;
// anything else (an answer, a missing action, or unparseable output) is treated as
// an answer so buildAnswerOutput can extract what it can and the loop terminates.
function parseAssessment(content: string): { action: "search"; queries: string[] } | { action: "answer" } {
  let parsed: unknown;
  try {
    parsed = extractJson(content);
  } catch {
    return { action: "answer" };
  }
  if (!parsed || typeof parsed !== "object" || (parsed as { action?: unknown }).action !== "search") {
    return { action: "answer" };
  }
  const raw = (parsed as { queries?: unknown }).queries;
  const queries = Array.isArray(raw)
    ? raw.filter((query): query is string => typeof query === "string" && query.trim().length > 0).map((query) => query.trim())
    : [];
  return queries.length > 0 ? { action: "search", queries } : { action: "answer" };
}

// The "[section <id>]" labelling shared by the answer and verify prompts, so the
// verifier reads the exact context representation the answer was drafted from.
function formatSectionContext(sections: RetrievedSection[]): string {
  return sections.map((section) => `[section ${section.sectionId}] # ${section.heading}\n${section.content}`).join("\n\n");
}

function mergeSections(pool: Map<string, RetrievedSection>, sections: RetrievedSection[]): void {
  for (const section of sections) {
    if (!pool.has(section.sectionId)) {
      pool.set(section.sectionId, section);
    }
  }
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

// Resolves which flow answers the question. A caller-pinned flow
// (`requestedFlowId`, already validated at the API) skips routing entirely;
// otherwise the model routes across the configured flows.
async function resolveFlow(
  requestedFlowId: string | undefined,
  question: string,
  flows: RoutableFlow[],
  model: ChatProvider,
  jobId: string
): Promise<FlowRoute> {
  if (requestedFlowId) {
    logger.debug({ jobId, flowId: requestedFlowId }, `answer_question[${jobId}]: using caller-specified flow ${requestedFlowId}`);
    return { status: "routed", flowId: requestedFlowId, confidence: "high" };
  }

  logger.debug({ jobId, flowCount: flows.length }, `answer_question[${jobId}]: routing question across ${flows.length} flow(s)`);
  return routeQuestionToFlow(question, flows, model, logger);
}

async function reconcileGapClusters({ job, model, signal }: GenerativeJobOptions): Promise<ReconcileOutput> {
  const input = reconcileGapClustersInputSchema.parse(job.input);

  const summary = input.clusters.map((cluster) => clusterSummaryLine(cluster)).join("\n");
  logger.debug({ jobId: job.id, clusterCount: input.clusters.length }, `reconcile_gap_clusters[${job.id}]: proposing reshape over ${input.clusters.length} cluster(s)`);
  const proposeResponse = await model.complete({
    system: GAP_RECONCILE_PROPOSE.instructions,
    messages: [{ role: "user", content: summary }],
    signal
  });
  const proposal = parseReshape(proposeResponse.content);

  logger.debug(
    { jobId: job.id, mergeCount: proposal.merges.length, splitCount: proposal.splits.length, dismissalCount: proposal.dismissals.length },
    `reconcile_gap_clusters[${job.id}]: critic-confirming ${proposal.merges.length} merge(s), ${proposal.splits.length} split(s), ${proposal.dismissals.length} dismissal(s)`
  );
  const merges: ReconcileOutput["merges"] = [];
  for (const merge of proposal.merges) {
    const confirmed = await criticConfirm(model, "merge", merge.rationale, signal);
    merges.push({ clusterIds: merge.clusterIds, rationale: merge.rationale, confirmed });
  }
  const splits: ReconcileOutput["splits"] = [];
  for (const split of proposal.splits) {
    const confirmed = await criticConfirm(model, "split", split.rationale, signal);
    splits.push({ clusterId: split.clusterId, children: split.children, rationale: split.rationale, confirmed });
  }
  // Dismissals are permanent, so the critic sees the same scope grounding the
  // proposer did (persona, top relevance, snippets) and must independently confirm
  // the cluster is off-topic — not merely uncovered — before we drop it.
  const dismissals: ReconcileOutput["dismissals"] = [];
  for (const dismissal of proposal.dismissals) {
    const cluster = input.clusters.find((entry) => entry.id === dismissal.clusterId);
    const context = cluster ? clusterSummaryLine(cluster) : undefined;
    const confirmed = await criticConfirm(model, "dismissal", dismissal.rationale, signal, context);
    dismissals.push({ clusterId: dismissal.clusterId, rationale: dismissal.rationale, confirmed });
  }

  return reconcileGapClustersOutputSchema.parse({ merges, splits, dismissals });
}

// One line describing a cluster for the propose/critic prompts, including the scope
// grounding the API attached (persona, best retrieval relevance, closest snippets)
// so the model can tell an off-topic cluster from an on-topic-but-uncovered one.
function clusterSummaryLine(cluster: ReconcileInput["clusters"][number]): string {
  const base = `cluster ${cluster.id} (flow ${cluster.flowId ?? "none"}): ${cluster.title}`;
  if (!cluster.scope) {
    return base;
  }
  const persona = cluster.scope.persona ?? "n/a";
  const snippets = cluster.scope.snippets.length > 0
    ? cluster.scope.snippets.map((snippet) => JSON.stringify(snippet)).join(" | ")
    : "none";
  return `${base} [scope: persona=${persona}; topRelevance=${cluster.scope.topRelevance.toFixed(2)}; closest content=${snippets}]`;
}

async function criticConfirm(
  model: ChatProvider,
  kind: "merge" | "split" | "dismissal",
  rationale: string,
  signal: AbortSignal,
  context?: string
): Promise<boolean> {
  const content = context
    ? `Proposed ${kind}. Rationale: ${rationale}\n\nCluster under review: ${context}`
    : `Proposed ${kind}. Rationale: ${rationale}`;
  const response = await model.complete({
    system: GAP_RECONCILE_CRITIC.instructions,
    messages: [{ role: "user", content }],
    signal
  });
  try {
    const parsed = JSON.parse(response.content) as { confirmed?: unknown };
    return parsed.confirmed === true;
  } catch {
    return false;
  }
}

function parseReshape(content: string): { merges: ProposedMerge[]; splits: ProposedSplit[]; dismissals: ProposedDismissal[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { merges: [], splits: [], dismissals: [] };
  }
  if (!parsed || typeof parsed !== "object") {
    return { merges: [], splits: [], dismissals: [] };
  }
  const candidate = parsed as { merges?: unknown; splits?: unknown; dismissals?: unknown };
  return {
    merges: Array.isArray(candidate.merges) ? candidate.merges.filter(isProposedMerge) : [],
    splits: Array.isArray(candidate.splits) ? candidate.splits.filter(isProposedSplit) : [],
    dismissals: Array.isArray(candidate.dismissals) ? candidate.dismissals.filter(isProposedDismissal) : []
  };
}

function isProposedMerge(value: unknown): value is ProposedMerge {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { clusterIds?: unknown; rationale?: unknown };
  return (
    Array.isArray(candidate.clusterIds) &&
    candidate.clusterIds.every((id) => typeof id === "string") &&
    typeof candidate.rationale === "string"
  );
}

function isProposedDismissal(value: unknown): value is ProposedDismissal {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { clusterId?: unknown; rationale?: unknown };
  return typeof candidate.clusterId === "string" && typeof candidate.rationale === "string";
}

function isProposedSplit(value: unknown): value is ProposedSplit {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { clusterId?: unknown; children?: unknown; rationale?: unknown };
  return (
    typeof candidate.clusterId === "string" &&
    typeof candidate.rationale === "string" &&
    Array.isArray(candidate.children) &&
    candidate.children.every(
      (child) =>
        Boolean(child) &&
        typeof child === "object" &&
        Array.isArray((child as { gapIds?: unknown }).gapIds) &&
        (child as { gapIds: unknown[] }).gapIds.every((id) => typeof id === "string")
    )
  );
}
