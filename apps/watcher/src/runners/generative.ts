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
  CONDENSE_FOLLOWUP,
  GAP_RECONCILE_CRITIC,
  GAP_RECONCILE_PROPOSE,
  JOB_RUNNER_SYSTEM,
  RECONCILE_ANSWER,
  VERIFY_ANSWER,
  withPersona,
  wrapUntrusted
} from "@magpie/prompts";
import { routeQuestionToFlow, type FlowRoute, type RoutableFlow } from "@magpie/retrieval";
import type { z } from "zod";
import type { RetrievedSection, WatcherApi } from "../http-client.js";
import { logger } from "../logger.js";
import { stampSourceMapUpdates } from "../source-workspace.js";
import {
  applyGroundingVerdict,
  buildAnswerOutput,
  buildFlowSelectionRequiredOutput,
  buildPrompt,
  extractJson,
  forcedSearchQueries,
  parseGroundingVerdict,
  parseJobOutput,
  parseReconcileVerdict,
  selectCitations,
  UNPARSEABLE_ANSWER_FALLBACK,
  withVerification,
  type AnswerLoopTrace,
  type AnswerOutput,
  type ReconcileDecision
} from "../job-prompts.js";
import type { AnswerCandidate, AnswerTrace } from "@magpie/core";

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
  // answer_question_batch (questionnaire drip, #288c) shares the answer contract
  // and provider routing with answer_question, so it runs the identical answer
  // handler — no new runner or capability. PROVIDER_JOB_TYPES is derived from the
  // catalog, so the Chat/CLI runners auto-claim it.
  if (job.type === "answer_question" || job.type === "answer_question_batch") {
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
  // The generative path never observes a checkout, so it can never vouch for a
  // model-supplied observedSha: stampSourceMapUpdates strips the field from every
  // mapUpdate when given an empty workspaces array (see source-workspace.ts for
  // the stamp/strip contract). Source-grounded job types that fall back here
  // (non-fs sources, or fs sources without an agent model) cannot smuggle a sha
  // the watcher didn't observe.
  return stampSourceMapUpdates(parseJobOutput(job, response.content), []);
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

type AnswerQuestionInput = z.infer<typeof answerQuestionInputSchema>;

// Entry point for the answer_question runner. When the job carries candidate prior
// answers (questionnaire trust), it first reconciles the question against them; a
// reuse verdict short-circuits before any synthesis. Otherwise — and on a fresh
// verdict — it runs the normal agentic answer flow unchanged.
async function answer(options: GenerativeJobOptions): Promise<unknown> {
  const input = answerQuestionInputSchema.parse(options.job.input);
  if (input.candidates && input.candidates.length > 0) {
    return reconcileOrAnswer(options, input, input.candidates);
  }
  return answerCore(options, input);
}

// The reconcile step (the ONLY place the watcher runs the model for reuse). It
// resolves the flow, does one seed retrieval, and asks the model to decide
// reused/adapted/merged/fresh against the live KB. A reuse verdict returns a built
// output directly; fresh (or an unparseable, fail-open verdict) falls through to the
// normal answer flow, whose output is stamped with reuse:{verdict:"fresh"} so the
// API always sees a decision when it primed candidates.
async function reconcileOrAnswer(
  options: GenerativeJobOptions,
  input: AnswerQuestionInput,
  candidates: AnswerCandidate[]
): Promise<unknown> {
  const { job, model, api, signal } = options;
  const flows: RoutableFlow[] = input.flows.map((flow) => ({
    id: flow.id,
    name: flow.name,
    ...(flow.persona ? { persona: flow.persona } : {})
  }));
  const pinnedFlowId = input.requestedFlowId ?? input.conversationFlowId;
  const { route } = await resolveFlow(pinnedFlowId, input.question, flows, model, api, job.id, signal);
  const flowId = route.status === "routed" ? route.flowId : undefined;

  logger.debug(
    { jobId: job.id, flowId: flowId ?? null, candidateCount: candidates.length },
    `answer_question[${job.id}]: reconciling against ${candidates.length} candidate(s)`
  );
  const seed = await api.retrieve(input.question, flowId, undefined, signal);
  const decision = await reconcileWithCandidates(model, input.question, candidates, seed, signal);

  if (decision && decision.verdict !== "fresh") {
    logger.debug(
      { jobId: job.id, verdict: decision.verdict, basisItemIds: decision.basisItemIds },
      `answer_question[${job.id}]: reconciled to ${decision.verdict} from ${decision.basisItemIds.length} candidate(s)`
    );
    return buildReconciledOutput(decision, seed, flowId);
  }

  logger.debug(
    { jobId: job.id },
    `answer_question[${job.id}]: reconcile returned fresh; running the normal answer flow`
  );
  const output = await answerCore(options, input);
  return { ...output, reuse: { verdict: "fresh", basisItemIds: [] } };
}

// One reconcile model call. The candidate prior answers and the retrieved sections
// are both untrusted reference material (RECONCILE_ANSWER carries the untrusted
// contract), so each is wrapped in the shared delimiters. Fails open via
// parseReconcileVerdict — an unparseable reply yields undefined.
async function reconcileWithCandidates(
  model: ChatProvider,
  question: string,
  candidates: AnswerCandidate[],
  sections: RetrievedSection[],
  signal: AbortSignal
): Promise<ReconcileDecision | undefined> {
  const candidateBlock = candidates
    .map((candidate) => `Candidate ${candidate.itemId}:\nQ: ${candidate.question}\nA: ${candidate.answer}`)
    .join("\n\n");
  const context =
    sections.length > 0
      ? wrapUntrusted(formatSectionContext(sections))
      : "(no current knowledge-base sections retrieved)";
  const response = await model.complete({
    system: RECONCILE_ANSWER.instructions,
    messages: [
      {
        role: "user",
        content: `Question:\n${question}\n\nCandidate prior answers:\n${wrapUntrusted(candidateBlock)}\n\nCurrent knowledge-base sections:\n${context}`
      }
    ],
    responseFormat: "json",
    signal
  });
  return parseReconcileVerdict(response.content);
}

// Builds the answer_question output for a reuse verdict. The answer text is the
// model's for adapted/merged and empty for reused (the API copies the real answer
// verbatim by id). Citations are derived in code from the seed sections — never
// from the model — like every other answer path; confidence is high because the
// answer rests on a prior APPROVED item still supported by the live KB.
function buildReconciledOutput(
  decision: ReconcileDecision,
  sections: RetrievedSection[],
  flowId: string | undefined
): AnswerOutput {
  const { citations } = selectCitations(sections, []);
  return {
    answer: decision.verdict === "reused" ? "" : decision.answer,
    confidence: "high",
    citations,
    ...(flowId ? { flowId } : {}),
    reuse: { verdict: decision.verdict, basisItemIds: decision.basisItemIds }
  };
}

// The normal agentic answer flow (route -> seed retrieval -> assess/search rounds ->
// answer -> grounding check). Unchanged from before the reconcile step existed; the
// caller parses the input and passes it in.
async function answerCore(
  { job, model, api, signal }: GenerativeJobOptions,
  input: AnswerQuestionInput
): Promise<AnswerOutput> {
  const flows: RoutableFlow[] = input.flows.map((flow) => ({
    id: flow.id,
    name: flow.name,
    ...(flow.persona ? { persona: flow.persona } : {})
  }));

  // Multi-turn conversations (#239). When the API supplied prior turns, condense
  // the (possibly terse) follow-up into a self-contained question and use THAT for
  // routing, retrieval, answering, and grounding — so "what about the EU?" embeds
  // and answers as "What is the data retention policy for the EU region?". The raw
  // follow-up stays on the question log for display; `condensed` is reported back
  // for gap hygiene. Condensation failure falls back to the raw question, so a
  // conversation never breaks answering.
  const priorTurns = input.priorTurns ?? [];
  const retrievalQuestion =
    priorTurns.length > 0 ? await condenseFollowup(model, input.question, priorTurns, signal, job.id) : input.question;
  const condensed = retrievalQuestion !== input.question ? retrievalQuestion : undefined;
  const stamp = <T extends AnswerOutput>(output: T): T =>
    condensed ? { ...output, standaloneQuestion: condensed } : output;

  // Routing is sticky within a conversation: the caller's explicit pin wins, else
  // the flow the conversation already settled on (conversationFlowId), else auto.
  const pinnedFlowId = input.requestedFlowId ?? input.conversationFlowId;
  const { route, method } = await resolveFlow(pinnedFlowId, retrievalQuestion, flows, model, api, job.id, signal);

  // The audit trail of this run, persisted with the question log so the console
  // can explain the answer: how routing went (and which router decided), what was
  // searched (and what came back empty), and — filled in later — whether grounding
  // verification ran.
  const routing: AnswerTrace["routing"] = {
    mode: pinnedFlowId
      ? "requested"
      : route.status === "routed"
        ? "routed"
        : route.status === "unroutable"
          ? "unscoped"
          : "unknown",
    ...(route.status === "routed" ? { flowId: route.flowId, confidence: route.confidence } : {}),
    ...(method ? { method } : {})
  };

  // "auto" routing could not pick a flow: withhold the answer and ask the caller
  // to choose one of the configured flows and re-ask.
  if (route.status === "unknown") {
    logger.debug({ jobId: job.id }, `answer_question[${job.id}]: routing unknown; requesting flow selection`);
    return stamp(
      buildFlowSelectionRequiredOutput(flows, {
        routing,
        seedSectionCount: 0,
        searches: [],
        poolSectionCount: 0,
        answerForced: false
      })
    );
  }

  const flowId = route.status === "routed" ? route.flowId : undefined;
  const routedFlow = flowId ? flows.find((flow) => flow.id === flowId) : undefined;
  const system = withPersona(ANSWER_QUESTION.instructions, routedFlow?.persona);

  // Deduped accumulator (sectionId -> section) plus the set of follow-up queries
  // that returned nothing above the relevance floor.
  const pool = new Map<string, RetrievedSection>();
  const unsatisfiedSearches = new Set<string>();

  logger.debug(
    { jobId: job.id, flowId: flowId ?? null },
    `answer_question[${job.id}]: seeding retrieval for flow ${flowId ?? "(unscoped)"}`
  );
  const seed = await api.retrieve(retrievalQuestion, flowId, undefined, signal);
  mergeSections(pool, seed);

  const searches: AnswerTrace["searches"] = [];
  const loopTrace = (answerForced: boolean): AnswerLoopTrace => ({
    routing,
    seedSectionCount: seed.length,
    searches: [...searches],
    poolSectionCount: pool.size,
    answerForced
  });

  const runSearches = async (queries: string[], round: number): Promise<void> => {
    for (const query of queries) {
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
  };

  for (let round = 0; round < MAX_SEARCH_ROUNDS && pool.size < MAX_POOL_SECTIONS; round += 1) {
    const content = await assess(model, system, retrievalQuestion, [...pool.values()], false, signal);
    const assessment = parseAssessment(content);
    if (assessment.action === "answer") {
      // A model that answers low / flags a knowledge gap on the very first round —
      // before any search has run — has given up prematurely (the exact failure that
      // makes the loop look like it "never searches"). Force one search round from
      // its own declared gaps so it decides with a fuller pool. Guarded on
      // searches.length === 0, so it fires at most once and the loop still converges.
      if (searches.length === 0) {
        const forced = forcedSearchQueries(content);
        if (forced.length > 0) {
          logger.debug(
            { jobId: job.id, round, queries: forced },
            `answer_question[${job.id}]: forcing ${forced.length} gap-derived search(es) before accepting a low-confidence answer`
          );
          await runSearches(forced, round);
          continue;
        }
      }
      logger.debug(
        { jobId: job.id, round, sectionCount: pool.size },
        `answer_question[${job.id}]: answered after ${round} search round(s)`
      );
      const output = buildAnswerOutput(
        content,
        [...pool.values()],
        retrievalQuestion,
        flowId,
        unsatisfiedSearches,
        loopTrace(false)
      );
      return stamp(await verifyAnswerGrounding(model, output, [...pool.values()], retrievalQuestion, signal, job.id));
    }

    logger.debug(
      { jobId: job.id, round, queries: assessment.queries },
      `answer_question[${job.id}]: running ${assessment.queries.length} follow-up search(es)`
    );
    await runSearches(assessment.queries, round);
  }

  // Ran out of search rounds or hit the section cap: force a final answer from
  // whatever has accumulated (no further searching allowed).
  logger.debug(
    { jobId: job.id, sectionCount: pool.size },
    `answer_question[${job.id}]: forcing final answer from ${pool.size} section(s)`
  );
  const finalContent = await assess(model, system, retrievalQuestion, [...pool.values()], true, signal);
  const output = buildAnswerOutput(
    finalContent,
    [...pool.values()],
    retrievalQuestion,
    flowId,
    unsatisfiedSearches,
    loopTrace(true)
  );
  return stamp(await verifyAnswerGrounding(model, output, [...pool.values()], retrievalQuestion, signal, job.id));
}

// Condenses a follow-up into a standalone question using the recent conversation
// turns. One provider call; on any failure (parse, empty result) it falls back to
// the raw follow-up so answering never breaks. The turns are rendered oldest-first
// as plain Q/A so the model sees the thread the way the user experienced it.
async function condenseFollowup(
  model: ChatProvider,
  question: string,
  priorTurns: Array<{ question: string; answer: string }>,
  signal: AbortSignal,
  jobId: string
): Promise<string> {
  const history = priorTurns.map((turn) => `Q: ${turn.question}\nA: ${turn.answer}`).join("\n\n");
  try {
    const response = await model.complete({
      system: CONDENSE_FOLLOWUP.instructions,
      messages: [
        {
          role: "user",
          content: `Conversation so far:\n${history}\n\nFollow-up question:\n${question}`
        }
      ],
      responseFormat: "json",
      signal
    });
    const parsed = extractJson(response.content);
    const standalone =
      parsed && typeof parsed === "object"
        ? (parsed as { standaloneQuestion?: unknown }).standaloneQuestion
        : undefined;
    if (typeof standalone === "string" && standalone.trim().length > 0) {
      logger.debug({ jobId }, `answer_question[${jobId}]: condensed follow-up into a standalone question`);
      return standalone.trim();
    }
  } catch (error) {
    logger.warn(
      { jobId, err: error },
      `answer_question[${jobId}]: follow-up condensation failed; using the raw question`
    );
  }
  return question;
}

// Post-answer grounding check: a second model call reviews the drafted answer
// against the retrieved pool and every unsupported claim is stripped, the answer
// downgraded to low, and the claims recorded as gaps. Medium/high answers are
// checked — including gap-flagged partial answers, which buildAnswerOutput now
// ships at "medium" when substantive and which carry claims worth vouching for
// like any other medium answer; out-of-scope and already-low answers ship
// distrusted anyway. An unparseable verdict fails open (keeps the drafted
// answer) so a flaky verifier cannot downgrade every answer.
//
// Exception on both counts: an UNSTRUCTURED answer (the model ignored the JSON
// contract and replied in prose) is always verified despite its low confidence,
// and fails CLOSED — when neither the contract nor the verifier can vouch for
// the prose, the safe fallback ships instead. Prose from a contract-ignoring
// model can be a genuine answer (grounded prose still ships verbatim), but it
// can also be conversational chatter — a CLI provider once asked the reader to
// grant it MCP tool permissions, and low confidence alone let that skip
// verification and ship as the "answer".
//
// To avoid re-sending the whole pool (already sent verbatim in the assess call), the
// context is split: the *cited* sections go in full, while the retrieved-but-uncited
// sections go as headings only. The prompt tells the verifier those headings were
// retrieved as relevant, so a claim matching one is treated as plausibly grounded
// rather than fabricated — preserving the "don't flag uncited-but-retrieved claims"
// property without re-sending every uncited body (#169 Part 1).
async function verifyAnswerGrounding(
  model: ChatProvider,
  output: AnswerOutput,
  sections: RetrievedSection[],
  question: string,
  signal: AbortSignal,
  jobId: string
): Promise<AnswerOutput> {
  const unstructured = output.trace?.answerContract === "unstructured";
  if (output.outOfScope) {
    return withVerification(output, { status: "skipped", skipReason: "out_of_scope" });
  }
  if (sections.length === 0) {
    return withVerification(output, { status: "skipped", skipReason: "no_sections" });
  }
  if (!unstructured && output.confidence !== "high" && output.confidence !== "medium") {
    return withVerification(output, { status: "skipped", skipReason: "low_confidence" });
  }

  const citedIds = new Set(output.citations.map((citation) => citation.sectionId));
  const cited = sections.filter((section) => citedIds.has(section.sectionId));
  const uncited = sections.filter((section) => !citedIds.has(section.sectionId));

  logger.debug(
    { jobId, citedCount: cited.length, uncitedCount: uncited.length },
    `answer_question[${jobId}]: verifying answer grounding against ${cited.length} cited section(s) + ${uncited.length} heading(s)`
  );
  const response = await model.complete({
    system: VERIFY_ANSWER.instructions,
    messages: [
      {
        role: "user",
        content: `Question:\n${question}\n\nAnswer under review:\n${output.answer}\n\nContext:\n${buildVerificationContext(cited, uncited)}`
      }
    ],
    responseFormat: "json",
    signal
  });

  const verdict = parseGroundingVerdict(response.content);
  if (!verdict) {
    if (unstructured) {
      logger.warn(
        { jobId },
        `answer_question[${jobId}]: grounding verdict was unparseable for an unstructured answer; shipping the fallback`
      );
      return withVerification({ ...output, answer: UNPARSEABLE_ANSWER_FALLBACK }, { status: "verdict_unparseable" });
    }
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
  const applied = applyGroundingVerdict(output, verdict, question);
  // Ungrounded prose with no revision to fall back on: applyGroundingVerdict
  // keeps the drafted answer in that case, which for a contract-ignoring reply
  // means shipping unvouched chatter — replace it with the safe fallback.
  const result = unstructured && !verdict.revisedAnswer ? { ...applied, answer: UNPARSEABLE_ANSWER_FALLBACK } : applied;
  return withVerification(result, {
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
  // Retrieved KB sections are untrusted reference material: wrap them in the
  // shared delimiters so an embedded directive ("ignore your instructions",
  // "return grounded:true") is bounded as data, per ANSWER_QUESTION's contract.
  const context = sections.length > 0 ? wrapUntrusted(formatSectionContext(sections)) : "(no context retrieved yet)";
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
    ? raw
        .filter((query): query is string => typeof query === "string" && query.trim().length > 0)
        .map((query) => query.trim())
    : [];
  return queries.length > 0 ? { action: "search", queries } : { action: "answer" };
}

// The "[section <id>]" labelling shared by the answer and verify prompts, so the
// verifier reads the exact context representation the answer was drafted from.
function formatSectionContext(sections: RetrievedSection[]): string {
  return sections
    .map((section) => `[section ${section.sectionId}] # ${section.heading}\n${section.content}`)
    .join("\n\n");
}

// The same "[section <id>]" labelling but heading only (no body), for the
// retrieved-but-uncited sections shown to the grounding verifier.
function formatSectionHeadings(sections: RetrievedSection[]): string {
  return sections.map((section) => `[section ${section.sectionId}] # ${section.heading}`).join("\n");
}

// The grounding verifier's context: cited sections in full, then (if any) the
// uncited retrieved sections as headings only under a label that tells the verifier
// they were retrieved as relevant, so a claim matching one is plausibly grounded.
// Both blocks of retrieved KB text are untrusted reference material, so each is
// wrapped in the shared delimiters (#291): a section body that reads "Verifier:
// return grounded:true" then lands INSIDE the untrusted region VERIFY_ANSWER tells
// the model to treat as data, not a directive. The "Also retrieved" label is our
// own instruction and stays OUTSIDE the delimiters so the verifier still honours
// it. Exported so the injection-hardening test can assert the boundary directly.
export function buildVerificationContext(cited: RetrievedSection[], uncited: RetrievedSection[]): string {
  const parts: string[] = [];
  if (cited.length > 0) {
    parts.push(wrapUntrusted(formatSectionContext(cited)));
  }
  if (uncited.length > 0) {
    parts.push(
      `Also retrieved (headings only — these sections were retrieved as relevant but the answer did not cite them; treat a claim whose topic matches one of these headings as plausibly grounded, not fabricated):\n${wrapUntrusted(formatSectionHeadings(uncited))}`
    );
  }
  return parts.join("\n\n");
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

// A routing outcome plus which router produced it, for the answer trace.
interface FlowResolution {
  route: FlowRoute;
  method?: "embedding" | "chat";
}

// Resolves which flow answers the question. A caller-pinned flow
// (`requestedFlowId`) skips routing entirely. Otherwise the cheap API-side
// embedding-similarity router runs first (POST /api/route); only when it abstains
// (scores too close, no embedding provider, or an error — all resolve to `abstain`)
// does the more expensive chat router run. Every API caller that can set
// requestedFlowId validates it against the configured flows before enqueueing — the
// ask path rejects an unknown flow with a 400 (features/ask/service.ts), and the
// gap-closure re-ask drops a stale flowId rather than pinning to a flow that may have
// been deleted/renamed since the proposal was drafted (features/proposals/service.ts)
// — so a value that reaches here is trusted as-is.
async function resolveFlow(
  requestedFlowId: string | undefined,
  question: string,
  flows: RoutableFlow[],
  model: ChatProvider,
  api: WatcherApi,
  jobId: string,
  signal: AbortSignal
): Promise<FlowResolution> {
  if (requestedFlowId) {
    logger.debug(
      { jobId, flowId: requestedFlowId },
      `answer_question[${jobId}]: using caller-specified flow ${requestedFlowId}`
    );
    return { route: { status: "routed", flowId: requestedFlowId, confidence: "high" } };
  }

  logger.debug(
    { jobId, flowCount: flows.length },
    `answer_question[${jobId}]: routing question across ${flows.length} flow(s)`
  );
  const embedded = await api.routeByEmbedding(question, flows, signal);
  if (embedded.status === "routed") {
    logger.debug(
      { jobId, flowId: embedded.flowId, margin: embedded.margin },
      `answer_question[${jobId}]: routed to ${embedded.flowId} by embedding similarity (margin ${embedded.margin.toFixed(3)})`
    );
    return {
      route: { status: "routed", flowId: embedded.flowId, confidence: embedded.confidence },
      method: "embedding"
    };
  }

  logger.debug({ jobId }, `answer_question[${jobId}]: embedding router abstained; falling back to the chat router`);
  const chat = await routeQuestionToFlow(question, flows, model, logger);
  return { route: chat, ...(chat.status === "routed" ? { method: "chat" as const } : {}) };
}

async function reconcileGapClusters({ job, model, signal }: GenerativeJobOptions): Promise<ReconcileOutput> {
  const input = reconcileGapClustersInputSchema.parse(job.input);

  const summary = input.clusters.map((cluster) => clusterSummaryLine(cluster)).join("\n");
  logger.debug(
    { jobId: job.id, clusterCount: input.clusters.length },
    `reconcile_gap_clusters[${job.id}]: proposing reshape over ${input.clusters.length} cluster(s)`
  );
  const proposeResponse = await model.complete({
    system: GAP_RECONCILE_PROPOSE.instructions,
    messages: [{ role: "user", content: summary }],
    // Ask for JSON explicitly, mirroring the critic call. Without it the provider
    // is free to wrap the proposal in a ```json fence or prose, which — combined with
    // a raw JSON.parse — used to silently discard the whole proposal and collapse
    // every reshape to "no merges" (the 100-singleton fan-out).
    responseFormat: "json",
    signal
  });
  const proposal = parseReshape(proposeResponse.content);

  const opCount = proposal.merges.length + proposal.splits.length + proposal.dismissals.length;
  // Surface the propose-side result (pre-critic) at info: the confirmed verdict alone
  // can't tell "the model proposed nothing" from "the critic rejected everything", and
  // an empty proposal over many clusters is the fan-out signature worth seeing in logs.
  logger.info(
    {
      jobId: job.id,
      clusterCount: input.clusters.length,
      proposeResponseChars: proposeResponse.content.length,
      mergeCount: proposal.merges.length,
      splitCount: proposal.splits.length,
      dismissalCount: proposal.dismissals.length
    },
    `reconcile_gap_clusters[${job.id}]: propose returned ${proposal.merges.length} merge(s), ${proposal.splits.length} split(s), ${proposal.dismissals.length} dismissal(s) over ${input.clusters.length} cluster(s)`
  );

  // One batched critic pass over every proposed operation (was one provider call per
  // op). Skip entirely when nothing was proposed. Each op is confirmed only when the
  // critic returns confirmed=true for its exact id; a missing, malformed, reordered, or
  // unparseable verdict leaves that op unconfirmed — the conservative default.
  const verdicts =
    opCount === 0 ? new Map<string, boolean>() : await criticConfirmBatch(model, proposal, input.clusters, signal);

  const merges: ReconcileOutput["merges"] = proposal.merges.map((merge, index) => ({
    clusterIds: merge.clusterIds,
    rationale: merge.rationale,
    confirmed: verdicts.get(`merge-${index}`) === true
  }));
  const splits: ReconcileOutput["splits"] = proposal.splits.map((split, index) => ({
    clusterId: split.clusterId,
    children: split.children,
    rationale: split.rationale,
    confirmed: verdicts.get(`split-${index}`) === true
  }));
  const dismissals: ReconcileOutput["dismissals"] = proposal.dismissals.map((dismissal, index) => ({
    clusterId: dismissal.clusterId,
    rationale: dismissal.rationale,
    confirmed: verdicts.get(`dismissal-${index}`) === true
  }));

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
  const snippets =
    cluster.scope.snippets.length > 0
      ? cluster.scope.snippets.map((snippet) => JSON.stringify(snippet)).join(" | ")
      : "none";
  return `${base} [scope: persona=${persona}; topRelevance=${cluster.scope.topRelevance.toFixed(2)}; closest content=${snippets}]`;
}

// One batched critic pass over every proposed operation. Each op is listed with a
// stable id (`merge-0`, `split-1`, `dismissal-0`) and its rationale; a dismissal also
// carries the cluster summary line so the critic sees the same scope grounding the
// proposer did (persona, top relevance, snippets) before we drop a cluster for good.
// Returns a map of op id -> confirmed; ids the critic omits or malforms are simply
// absent, and the caller treats an absent id as not confirmed.
async function criticConfirmBatch(
  model: ChatProvider,
  proposal: { merges: ProposedMerge[]; splits: ProposedSplit[]; dismissals: ProposedDismissal[] },
  clusters: ReconcileInput["clusters"],
  signal: AbortSignal
): Promise<Map<string, boolean>> {
  const lines: string[] = [];
  proposal.merges.forEach((merge, index) => {
    lines.push(`merge-${index}: merge clusters ${merge.clusterIds.join(", ")}. Rationale: ${merge.rationale}`);
  });
  proposal.splits.forEach((split, index) => {
    lines.push(`split-${index}: split cluster ${split.clusterId}. Rationale: ${split.rationale}`);
  });
  proposal.dismissals.forEach((dismissal, index) => {
    const cluster = clusters.find((entry) => entry.id === dismissal.clusterId);
    const context = cluster ? `\n  Cluster under review: ${clusterSummaryLine(cluster)}` : "";
    lines.push(
      `dismissal-${index}: dismiss cluster ${dismissal.clusterId}. Rationale: ${dismissal.rationale}${context}`
    );
  });

  const response = await model.complete({
    system: GAP_RECONCILE_CRITIC.instructions,
    messages: [
      {
        role: "user",
        content: `Proposed gap-cluster changes. Confirm or reject each independently.\n\n${lines.join("\n")}`
      }
    ],
    responseFormat: "json",
    signal
  });
  return parseCriticVerdicts(response.content);
}

// Parses the batched critic reply into a map of op id -> confirmed. Anything that is
// not exactly `confirmed: true` for a string id is dropped, so an unparseable reply, a
// missing `verdicts` array, or a malformed entry yields no confirmation for that op.
function parseCriticVerdicts(content: string): Map<string, boolean> {
  const verdicts = new Map<string, boolean>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return verdicts;
  }
  if (!parsed || typeof parsed !== "object") {
    return verdicts;
  }
  const raw = (parsed as { verdicts?: unknown }).verdicts;
  if (!Array.isArray(raw)) {
    return verdicts;
  }
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const id = (entry as { id?: unknown }).id;
    if (typeof id === "string") {
      verdicts.set(id, (entry as { confirmed?: unknown }).confirmed === true);
    }
  }
  return verdicts;
}

function parseReshape(content: string): {
  merges: ProposedMerge[];
  splits: ProposedSplit[];
  dismissals: ProposedDismissal[];
} {
  let parsed: unknown;
  try {
    // extractJson tolerates a ```json fence or surrounding prose (first `{` … last `}`),
    // the same lenient extraction every other job's output uses. A raw JSON.parse here
    // used to drop an otherwise-valid proposal whenever the provider added any wrapper.
    parsed = extractJson(content);
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
