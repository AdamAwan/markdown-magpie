import type { Citation, Confidence, FlowSelectionRequired, KnowledgeGapSignal, OutOfScope } from "@magpie/core";
import type { JobView } from "@magpie/jobs";
import { jobDefinition } from "@magpie/jobs";
import type { z } from "zod";
import {
  CORRECT_DOCUMENT,
  DEDUPE_DOCUMENTS,
  DRAFT_MARKDOWN_PROPOSAL,
  FOLD_CHANGESET_PROPOSAL,
  FOLD_MARKDOWN_PROPOSAL,
  GENERIC_JOB,
  IMPROVE_DOCUMENT,
  SOURCE_CHANGE_SYNC,
  SPLIT_DOCUMENT,
  SUMMARIZE_GAP,
  VERIFY_DOCUMENT
} from "@magpie/prompts";
import type { RetrievedSection } from "./http-client.js";

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
}

// The answer "auto" routing produces when it cannot determine a flow: no answer,
// confidence "unknown", and the list of flows the caller should choose between
// before re-asking. The UI and MCP key off `flowSelectionRequired`, not the prose.
export function buildFlowSelectionRequiredOutput(
  flows: Array<{ id: string; name: string }>
): AnswerOutput {
  return {
    answer:
      "I could not determine which knowledge area this question belongs to. " +
      "Please choose one of the available flows and ask again.",
    confidence: "unknown",
    citations: [],
    flowSelectionRequired: {
      availableFlows: flows.map((flow) => ({ id: flow.id, name: flow.name }))
    }
  };
}

// Per-job prompt for the generic chat path (everything except answer_question,
// which the answer runner assembles itself with its retrieved context). The
// job's input is embedded as JSON after the task instructions.
export function buildPrompt(job: JobView): string {
  switch (job.type) {
    case "summarize_gap":
      return `${SUMMARIZE_GAP.instructions}\n\nInput:\n${JSON.stringify(job.input, null, 2)}`;
    case "draft_markdown_proposal":
      return `${DRAFT_MARKDOWN_PROPOSAL.instructions}\n\nInput:\n${JSON.stringify(job.input, null, 2)}`;
    case "fold_markdown_proposal":
      return `${FOLD_MARKDOWN_PROPOSAL.instructions}\n\nInput:\n${JSON.stringify(job.input, null, 2)}`;
    case "fold_changeset_proposal":
      return `${FOLD_CHANGESET_PROPOSAL.instructions}\n\nInput:\n${JSON.stringify(job.input, null, 2)}`;
    case "sync_source_changes_generate_plan":
      return `${SOURCE_CHANGE_SYNC.instructions}\n\nInput:\n${JSON.stringify(job.input, null, 2)}`;
    case "verify_document":
      return `${VERIFY_DOCUMENT.instructions}\n\nInput:\n${JSON.stringify(job.input, null, 2)}`;
    case "correct_document":
      return `${CORRECT_DOCUMENT.instructions}\n\nInput:\n${JSON.stringify(job.input, null, 2)}`;
    case "dedupe_documents":
      return `${DEDUPE_DOCUMENTS.instructions}\n\nInput:\n${JSON.stringify(job.input, null, 2)}`;
    case "split_document":
      return `${SPLIT_DOCUMENT.instructions}\n\nInput:\n${JSON.stringify(job.input, null, 2)}`;
    case "improve_document":
      return `${IMPROVE_DOCUMENT.instructions}\n\nInput:\n${JSON.stringify(job.input, null, 2)}`;
    default:
      return `${GENERIC_JOB.instructions}\n\nJob:\n${JSON.stringify({ type: job.type, input: job.input }, null, 2)}`;
  }
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
// the ones the model says it used; a flagged knowledge gap forces low confidence
// and emits `auto` gap signals; `followup` gaps — supporting material the model
// searched for and did not find — are emitted even for a confident answer, but
// only when the loop actually observed a search return nothing (grounding them to
// real empty searches rather than model hunches).
export function buildAnswerOutput(
  modelContent: string,
  sections: RetrievedSection[],
  question: string,
  flowId: string | undefined,
  unsatisfiedSearches: Set<string> = new Set()
): AnswerOutput {
  const structured = parseStructuredAnswer(modelContent);
  const answer = structured?.answer ?? modelContent.trim();
  const { citations, attributionFailed } = selectCitations(sections, structured?.usedSectionIds ?? []);
  const citedSectionIds = citations.map((citation) => citation.sectionId);
  const followupGaps = groundedFollowupGaps(structured, question, citedSectionIds, unsatisfiedSearches);

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
      ...(flowId ? { flowId } : {})
    };
  }

  if (structured?.isKnowledgeGap || sections.length === 0) {
    const summaries =
      structured && structured.gaps.length > 0
        ? structured.gaps
        : [`No sufficient source material found for: ${question}`];
    const autoGaps = summaries.map((summary) => toGapSignal(summary, question, citedSectionIds, "low", "auto"));
    return {
      answer: answer || "I could not find reliable source material for this question.",
      confidence: "low",
      citations,
      gaps: [...autoGaps, ...followupGaps],
      ...(flowId ? { flowId } : {})
    };
  }

  // Confidence is only honoured when the model held up its side of the contract.
  // Output that did not parse as the structured answer, or that attributed the
  // answer to invented section ids, cannot be trusted as grounded — it ships at
  // "low" so the UI signals distrust instead of defaulting to quiet credibility.
  const confidence: Confidence = !structured || attributionFailed ? "low" : structured.confidence;
  return {
    answer,
    confidence,
    citations,
    ...(followupGaps.length > 0 ? { gaps: followupGaps } : {}),
    ...(flowId ? { flowId } : {})
  };
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

// Turns the model's followupGaps into gap signals, but only when the loop saw at
// least one search return nothing: the model may only claim missing supporting
// material if it actually went looking and came up empty. Each gap is stamped
// with the answer's confidence and linked to the sections the answer used.
function groundedFollowupGaps(
  structured: StructuredAnswer | undefined,
  question: string,
  citedSectionIds: string[],
  unsatisfiedSearches: Set<string>
): KnowledgeGapSignal[] {
  if (!structured || structured.followupGaps.length === 0 || unsatisfiedSearches.size === 0) {
    return [];
  }
  return structured.followupGaps.map((summary) =>
    toGapSignal(summary, question, citedSectionIds, structured.confidence, "followup")
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
  const isKnowledgeGap = candidate.isKnowledgeGap === true;
  return {
    answer: candidate.answer,
    confidence: isKnowledgeGap ? "low" : candidate.confidence,
    isKnowledgeGap,
    outOfScope: candidate.outOfScope === true,
    gaps: toStringArray(candidate.gaps),
    followupGaps: toStringArray(candidate.followupGaps),
    usedSectionIds: toStringArray(candidate.usedSectionIds)
  };
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
