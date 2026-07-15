import type {
  AnswerTrace,
  Citation,
  Confidence,
  FlowSelectionRequired,
  KnowledgeGapSignal,
  OutOfScope,
  SourceMapEntry
} from "@magpie/core";
import { NO_SOURCE_MATERIAL_GAP_PREFIX } from "@magpie/core";
import type { JobType, JobView } from "@magpie/jobs";
import { jobDefinition } from "@magpie/jobs";
import type { z } from "zod";
import {
  CORRECT_DOCUMENT,
  DEDUPE_DOCUMENTS,
  DRAFT_MARKDOWN_PROPOSAL,
  DRAFT_SEED_DOCUMENT,
  FOLD_CHANGESET_PROPOSAL,
  FOLD_MARKDOWN_PROPOSAL,
  GENERIC_JOB,
  IMPROVE_DOCUMENT,
  OUTLINE_FLOW_SEED,
  SOURCE_CHANGE_SYNC,
  SPLIT_DOCUMENT,
  SUMMARIZE_GAP,
  VERIFY_DOCUMENT
} from "@magpie/prompts";
import type { FetchableInternetSource } from "./fetch-url.js";
import type { RetrievedSection } from "./http-client.js";
import type { SourceWorkspace } from "./source-workspace.js";

// The answer-question output the watcher returns after route -> retrieve ->
// answer. Citations are derived in code (never trusted from the model), so this
// is built by buildAnswerOutput rather than parsed from the model's JSON.
export interface AnswerOutput {
  answer: string;
  confidence: Confidence;
  citations: Citation[];
  gaps?: KnowledgeGapSignal[];
  flowId?: string;
  flowSelectionRequired?: FlowSelectionRequired;
  outOfScope?: OutOfScope;
  trace?: AnswerTrace;
}

// The loop-level portion of the trace the answer runner assembles as it goes
// (routing, searches, pool). buildAnswerOutput completes it with the answer
// contract, and the grounding check fills in the verification outcome.
export type AnswerLoopTrace = Omit<AnswerTrace, "answerContract" | "verification">;

// The answer "auto" routing produces when it cannot determine a flow: no answer,
// confidence "unknown", and the list of flows the caller should choose between
// before re-asking. The UI and MCP key off `flowSelectionRequired`, not the prose.
export function buildFlowSelectionRequiredOutput(
  flows: Array<{ id: string; name: string }>,
  loopTrace?: AnswerLoopTrace
): AnswerOutput {
  return {
    answer:
      "I could not determine which knowledge area this question belongs to. " +
      "Please choose one of the available flows and ask again.",
    confidence: "unknown",
    citations: [],
    flowSelectionRequired: {
      availableFlows: flows.map((flow) => ({ id: flow.id, name: flow.name }))
    },
    // No answer was drafted, so there is no contract to report; the trace still
    // explains that routing abstained and nothing was retrieved or verified.
    ...(loopTrace
      ? { trace: { ...loopTrace, verification: { status: "skipped", skipReason: "flow_selection_required" } } }
      : {})
  };
}

// The task instructions for each generic chat job type (everything except
// answer_question, which the answer runner assembles itself with its retrieved
// context). A type with no entry falls back to the generic job envelope.
const JOB_INSTRUCTIONS: Partial<Record<JobType, string>> = {
  summarize_gap: SUMMARIZE_GAP.instructions,
  draft_markdown_proposal: DRAFT_MARKDOWN_PROPOSAL.instructions,
  draft_seed_document: DRAFT_SEED_DOCUMENT.instructions,
  outline_flow_seed: OUTLINE_FLOW_SEED.instructions,
  fold_markdown_proposal: FOLD_MARKDOWN_PROPOSAL.instructions,
  fold_changeset_proposal: FOLD_CHANGESET_PROPOSAL.instructions,
  sync_source_changes_generate_plan: SOURCE_CHANGE_SYNC.instructions,
  verify_document: VERIFY_DOCUMENT.instructions,
  correct_document: CORRECT_DOCUMENT.instructions,
  dedupe_documents: DEDUPE_DOCUMENTS.instructions,
  split_document: SPLIT_DOCUMENT.instructions,
  improve_document: IMPROVE_DOCUMENT.instructions
};

// Per-job prompt for the generic chat path: the task instructions followed by
// the job's input embedded as JSON. Source-grounded jobs (whose inputs carry
// `sources` descriptors) render through buildSourceGroundedPrompt on the agentic
// paths instead; the old shared-corpus leading block this function once rendered
// died with the corpus pipeline.
export function buildPrompt(job: JobView): string {
  const instructions = JOB_INSTRUCTIONS[job.type];
  if (!instructions) {
    return `${GENERIC_JOB.instructions}\n\nJob:\n${JSON.stringify({ type: job.type, input: job.input }, null, 2)}`;
  }
  return `${instructions}\n\nInput:\n${JSON.stringify(job.input, null, 2)}`;
}

// Prompt for source-grounded jobs on the agentic paths. The instructions come
// from the same catalog entry both tiers share; what differs is how the agent
// addresses the source material — the CLI tier works inside the checkout with its
// native tools, the tool-loop tier addresses "<sourceId>/<relative path>" through
// list_dir/read_file/grep. The job input is rendered WITHOUT the `sources` field:
// the descriptors were resolved into the workspace listing above, so the raw
// references would be noise.
export function buildSourceGroundedPrompt(
  job: JobView,
  workspaces: SourceWorkspace[],
  notes: string[],
  mode: "cli" | "tools",
  mapEntries: SourceMapEntry[] = [],
  fetchable: FetchableInternetSource[] = []
): string {
  const instructions = JOB_INSTRUCTIONS[job.type] ?? GENERIC_JOB.instructions;
  const workspaceLines = workspaces
    .map((ws) =>
      mode === "cli"
        ? `- ${ws.name}: ${ws.rootDir}${workspaces.indexOf(ws) === 0 ? " (your working directory)" : ""}`
        : `- ${ws.name}: address paths as "${ws.sourceId}/<relative path>" in list_dir/read_file/grep`
    )
    .join("\n");
  const access =
    mode === "cli"
      ? "Source repositories available (read-only; explore with your file tools):"
      : "Source repositories available through your tools (list_dir, read_file, grep):";
  // A job can be grounded in fetchable internet sources alone (#242); render the
  // repository block only when there is a repository to explore.
  const repoBlock = workspaces.length > 0 ? `${access}\n${workspaceLines}\n` : "";
  // Fetchable internet sources (#242). The tool names differ per tier: the tool
  // loop exposes fetch_url; a CLI agent uses its own web-fetch tool (the runner
  // only passes sources here when its CLI can actually fetch). Fetched pages are
  // reference material like any other source — the factual-register and
  // grounding contracts in the job instructions apply to them unchanged.
  const fetchBlock =
    fetchable.length > 0
      ? `\nInternet sources available through ${mode === "cli" ? "your web-fetch tool" : "the fetch_url tool"} (https only; hosts outside the allowlist are refused):\n${fetchable
          .map(
            (source) =>
              `- ${source.name}:${source.url ? ` start at ${source.url};` : ""} allowed hosts: ${source.allowedHosts.join(", ")}`
          )
          .join("\n")}\n`
      : "";
  const noteBlock = notes.length > 0 ? `\nSource notes:\n${notes.map((n) => `- ${n}`).join("\n")}\n` : "";
  // Navigation hints recorded by previous agents. Deliberately framed as
  // unverified: they are starting points for exploration, never facts to cite.
  const mapBlock =
    mapEntries.length > 0
      ? `\nSource map hints — notes from previous agents about where things live. These are unverified: use them as starting points and verify against the repository before relying on them.\n${mapEntries
          .map((entry) => `- [${entry.sourceId}] ${entry.topic}: ${entry.paths.join(", ")} — ${entry.description}`)
          .join("\n")}\n`
      : "";
  const input = omitInputKeys(job.input, ["sources"]);
  return `${repoBlock}${fetchBlock}${noteBlock}${mapBlock}\n${instructions}\n\nInput:\n${JSON.stringify(input, null, 2)}`;
}

// A shallow copy of a job input without the named keys. Used by the
// source-grounded prompt to drop `sources` — the descriptors are resolved into
// the workspace listing above, so the raw references would be noise.
function omitInputKeys(input: unknown, keys: string[]): unknown {
  if (typeof input !== "object" || input === null) {
    return input;
  }
  return Object.fromEntries(Object.entries(input).filter(([key]) => !keys.includes(key)));
}

// Parses and validates a model's JSON against the job's output contract from
// @magpie/jobs. Tolerates surrounding prose by extracting the first JSON object.
// answer_question is intentionally not handled here — its output is built from
// retrieved sections via buildAnswerOutput.
export function parseJobOutput(job: JobView, stdout: string): unknown {
  const parsed = extractJson(stdout);
  const schema = jobDefinition(job.type).outputSchema as z.ZodType<unknown>;
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${job.type} output does not match the job contract: ${result.error.message}`);
  }
  return result.data;
}

// Builds the answer_question output from the model's final answer text and the
// sections the watcher accumulated across the agentic retrieval loop. Citations
// are derived from those sections (never trusted from the model) but narrowed to
// the ones the model says it used; a flagged knowledge gap emits `auto` gap
// signals and caps confidence at "medium" — a substantive partial answer (the
// model rated itself medium/high and grounded the answer in honoured citations)
// ships at "medium", while a gap answer with nothing behind it is forced to
// "low"; `followup` gaps — supporting material the model searched for and did
// not find — are emitted even for a confident answer, but only when the loop
// actually observed a search return nothing (grounding them to real empty
// searches rather than model hunches).
// Shown instead of the raw model reply when the model was asked for a structured
// answer but produced something we could not parse. Never surface the unparsed
// text: a broken JSON envelope (e.g. an unescaped quote inside a string) would
// otherwise leak `{"action":"answer",...}` to the reader as if it were the answer.
export const UNPARSEABLE_ANSWER_FALLBACK =
  "I could not produce a reliable answer to this question from the current knowledge base.";

export function buildAnswerOutput(
  modelContent: string,
  sections: RetrievedSection[],
  question: string,
  flowId: string | undefined,
  unsatisfiedSearches: Set<string> = new Set(),
  loopTrace?: AnswerLoopTrace
): AnswerOutput {
  const structured = parseStructuredAnswer(modelContent);
  // A reply that opened as a JSON object but failed to parse was a broken attempt at
  // the structured contract, not a plain-prose answer — surface a safe fallback
  // rather than the raw envelope. Genuine prose (does not start with "{") is still
  // kept verbatim so a model that ignores the contract can still be understood.
  const answer =
    structured?.answer ??
    (modelContent.trim().startsWith("{") ? UNPARSEABLE_ANSWER_FALLBACK : modelContent.trim());
  const { citations, attributionFailed } = selectCitations(sections, structured?.usedSectionIds ?? []);
  const citedSectionIds = citations.map((citation) => citation.sectionId);
  // The verification outcome is a placeholder here; the grounding check in the
  // answer runner overwrites it with what actually happened (ran/skipped and why).
  const trace: AnswerTrace | undefined = loopTrace
    ? {
        ...loopTrace,
        answerContract: structured ? "structured" : "unstructured",
        verification: { status: "skipped" }
      }
    : undefined;

  // Off-topic for this flow's knowledge area: the flow declines to answer and — the
  // point of the whole check — emits NO gaps, so an unrelated question (e.g. "cats"
  // asked of a product flow) never clusters or drafts a proposal. Checked before the
  // knowledge-gap branch so empty retrieval on an off-topic question does not fall
  // through into an auto gap.
  if (structured?.outOfScope) {
    return {
      answer: answer || "This question does not appear to relate to this knowledge base.",
      confidence: "unknown",
      citations: [],
      outOfScope: answer ? { reason: answer } : {},
      ...(flowId ? { flowId } : {}),
      ...(trace ? { trace } : {})
    };
  }

  if (structured?.isKnowledgeGap || sections.length === 0) {
    const summaries =
      structured && structured.gaps.length > 0
        ? structured.gaps
        : [`${NO_SOURCE_MATERIAL_GAP_PREFIX} ${question}`];
    // A flagged gap no longer forces "low" across the board. A gap-flagged answer
    // that still substantively answers the core of the question — the model rated
    // itself medium/high, produced real answer text, and grounded it in honoured
    // citations — ships as a partial answer at "medium": capped below "high"
    // because a declared whole-question gap means the question is not fully
    // answered, but not branded untrustworthy. A gap answer with nothing behind
    // it (self-rated low/unknown, no citations, invented section ids, or empty
    // retrieval) keeps the forced "low" so the UI signals distrust. Either way
    // the auto gap signals are emitted, so gap clustering sees the misses.
    const substantive =
      structured !== undefined &&
      (structured.confidence === "high" || structured.confidence === "medium") &&
      answer.trim().length > 0 &&
      citations.length > 0 &&
      !attributionFailed;
    const confidence: Confidence = substantive ? "medium" : "low";
    const autoGaps = summaries.map((summary) => toGapSignal(summary, question, citedSectionIds, confidence, "auto"));
    const followupGaps = groundedFollowupGaps(structured, question, citedSectionIds, unsatisfiedSearches, confidence);
    return {
      answer: answer || "I could not find reliable source material for this question.",
      confidence,
      citations,
      gaps: [...autoGaps, ...followupGaps],
      ...(flowId ? { flowId } : {}),
      ...(trace ? { trace } : {})
    };
  }

  // Confidence is only honoured when the model held up its side of the contract.
  // Output that did not parse as the structured answer, or that attributed the
  // answer to invented section ids, cannot be trusted as grounded — it ships at
  // "low" so the UI signals distrust instead of defaulting to quiet credibility.
  const confidence: Confidence = !structured || attributionFailed ? "low" : structured.confidence;
  const followupGaps = groundedFollowupGaps(structured, question, citedSectionIds, unsatisfiedSearches, confidence);
  return {
    answer,
    confidence,
    citations,
    ...(followupGaps.length > 0 ? { gaps: followupGaps } : {}),
    ...(flowId ? { flowId } : {}),
    ...(trace ? { trace } : {})
  };
}

// Records what the grounding check actually did on the output's trace. A no-op
// for outputs built without a loop trace (unit tests, legacy callers).
export function withVerification(output: AnswerOutput, verification: AnswerTrace["verification"]): AnswerOutput {
  return output.trace ? { ...output, trace: { ...output.trace, verification } } : output;
}

// Narrows the accumulated pool to the sections the model actually used, ordered
// strongest-first. Falls back to the whole pool when the model named no valid ids
// (or none that were retrieved) so a real answer never loses its attribution —
// but naming ONLY ids that were never retrieved is a broken attribution
// (`attributionFailed`), which the caller treats as untrustworthy and downgrades.
function selectCitations(
  sections: RetrievedSection[],
  usedSectionIds: string[]
): { citations: Citation[]; attributionFailed: boolean } {
  const all = sections.map(toCitation).sort((left, right) => right.relevance - left.relevance);
  if (usedSectionIds.length === 0) {
    return { citations: all, attributionFailed: false };
  }
  const used = new Set(usedSectionIds);
  const grounded = all.filter((citation) => used.has(citation.sectionId));
  return grounded.length > 0
    ? { citations: grounded, attributionFailed: false }
    : { citations: all, attributionFailed: true };
}

// The grounding verifier's verdict on a drafted answer: either every claim is
// supported by the retrieved context, or the unsupported claims are listed (as
// missing topics) alongside a revised answer with them removed.
export interface GroundingVerdict {
  grounded: boolean;
  unsupportedClaims: string[];
  revisedAnswer?: string;
}

// Parses the verify-answer model reply. Anything that does not carry a boolean
// "grounded" is unusable — the caller fails open (keeps the drafted answer) so a
// flaky verifier degrades to the pre-verification behaviour rather than
// downgrading every answer.
export function parseGroundingVerdict(content: string): GroundingVerdict | undefined {
  let parsed: unknown;
  try {
    parsed = extractJson(content);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const candidate = parsed as { grounded?: unknown; unsupportedClaims?: unknown; revisedAnswer?: unknown };
  if (typeof candidate.grounded !== "boolean") {
    return undefined;
  }
  const revisedAnswer = typeof candidate.revisedAnswer === "string" ? candidate.revisedAnswer.trim() : "";
  return {
    grounded: candidate.grounded,
    unsupportedClaims: toStringArray(candidate.unsupportedClaims),
    ...(revisedAnswer ? { revisedAnswer } : {})
  };
}

// Applies a failed grounding verdict to a built answer: the revised
// (fabrication-free) answer replaces the draft, confidence drops to low, and each
// unsupported claim is recorded as an auto gap — a question that tempted the model
// to fabricate is exactly a question the knowledge base should learn to answer, so
// the stripped claims feed gap clustering like any other weak answer.
export function applyGroundingVerdict(
  output: AnswerOutput,
  verdict: GroundingVerdict,
  question: string
): AnswerOutput {
  if (verdict.grounded) {
    return output;
  }
  const citedSectionIds = output.citations.map((citation) => citation.sectionId);
  const claimGaps = verdict.unsupportedClaims.map((claim) =>
    toGapSignal(claim, question, citedSectionIds, "low", "auto")
  );
  const gaps = [...(output.gaps ?? []), ...claimGaps];
  return {
    ...output,
    answer: verdict.revisedAnswer ?? output.answer,
    confidence: "low",
    ...(gaps.length > 0 ? { gaps } : {})
  };
}

// Turns the model's followupGaps into gap signals, but only when the loop saw at
// least one search return nothing: the model may only claim missing supporting
// material if it actually went looking and came up empty. Each gap is stamped
// with the confidence the answer actually ships at (the caller's post-contract
// effective confidence, not the model's raw self-rating) and linked to the
// sections the answer used.
function groundedFollowupGaps(
  structured: StructuredAnswer | undefined,
  question: string,
  citedSectionIds: string[],
  unsatisfiedSearches: Set<string>,
  confidence: Confidence
): KnowledgeGapSignal[] {
  if (!structured || structured.followupGaps.length === 0 || unsatisfiedSearches.size === 0) {
    return [];
  }
  return structured.followupGaps.map((summary) =>
    toGapSignal(summary, question, citedSectionIds, confidence, "followup")
  );
}

interface StructuredAnswer {
  answer: string;
  confidence: Confidence;
  isKnowledgeGap: boolean;
  outOfScope: boolean;
  gaps: string[];
  followupGaps: string[];
  usedSectionIds: string[];
}

function parseStructuredAnswer(content: string): StructuredAnswer | undefined {
  let parsed: unknown;
  try {
    parsed = extractJson(content);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const candidate = parsed as {
    answer?: unknown;
    confidence?: unknown;
    isKnowledgeGap?: unknown;
    outOfScope?: unknown;
    gaps?: unknown;
    followupGaps?: unknown;
    usedSectionIds?: unknown;
  };
  if (typeof candidate.answer !== "string" || !isConfidence(candidate.confidence)) {
    return undefined;
  }
  // The model's raw self-rating is kept here even when isKnowledgeGap is set:
  // buildAnswerOutput decides the shipped confidence (a substantive gap-flagged
  // answer caps at "medium"; a no-substance one is forced to "low").
  const isKnowledgeGap = candidate.isKnowledgeGap === true;
  return {
    answer: candidate.answer,
    confidence: candidate.confidence,
    isKnowledgeGap,
    outOfScope: candidate.outOfScope === true,
    gaps: toStringArray(candidate.gaps),
    followupGaps: toStringArray(candidate.followupGaps),
    usedSectionIds: toStringArray(candidate.usedSectionIds)
  };
}

// The searches to force before accepting an answer the model gave up on. When the
// model answers low / flags a knowledge gap before any search has run, its own
// declared gaps name exactly what is missing — turn them into search queries so the
// pool grows before the loop trusts a low-confidence answer. Returns [] when the
// answer is confident, off-topic, names nothing to search for, or did not parse
// (json mode should prevent that; the loop then just accepts the answer).
export function forcedSearchQueries(modelContent: string, max = 3): string[] {
  const structured = parseStructuredAnswer(modelContent);
  if (!structured || structured.outOfScope) {
    return [];
  }
  const gaveUp = structured.isKnowledgeGap || structured.confidence === "low";
  return gaveUp ? structured.gaps.slice(0, max) : [];
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
    : [];
}

function toCitation(section: RetrievedSection): Citation {
  return {
    documentId: section.documentId,
    sectionId: section.sectionId,
    path: section.path,
    heading: section.heading,
    anchor: section.anchor,
    excerpt: section.content.slice(0, 280),
    relevance: section.relevance
  };
}

function toGapSignal(
  summary: string,
  question: string,
  citedSectionIds: string[],
  confidence: Confidence,
  source: KnowledgeGapSignal["source"]
): KnowledgeGapSignal {
  return { summary, question, confidence, citedSectionIds, source };
}

function isConfidence(value: unknown): value is Confidence {
  return value === "high" || value === "medium" || value === "low" || value === "unknown";
}

// Parses the first JSON object out of model output, tolerating surrounding prose.
// Exported so the answer loop can classify assess replies with the same tolerance.
export function extractJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first === -1 || last === -1 || last <= first) {
      throw new Error("Model output did not contain a JSON object");
    }
    return JSON.parse(trimmed.slice(first, last + 1));
  }
}
