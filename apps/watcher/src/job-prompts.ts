import type { Citation, Confidence, KnowledgeGapSignal } from "@magpie/core";
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

// Builds the answer_question output from the model's answer text and the sections
// the watcher retrieved for the (routed) question. Citations are derived from
// those sections so attribution stays reliable regardless of what the model
// claims; a flagged knowledge gap forces low confidence and emits gap signals.
export function buildAnswerOutput(
  modelContent: string,
  sections: RetrievedSection[],
  question: string,
  flowId: string | undefined
): AnswerOutput {
  const citations = sections.map(toCitation);
  const structured = parseStructuredAnswer(modelContent);
  const answer = structured?.answer ?? modelContent.trim();

  if (structured?.isKnowledgeGap || sections.length === 0) {
    const citedSectionIds = citations.map((citation) => citation.sectionId);
    const summaries =
      structured && structured.gaps.length > 0
        ? structured.gaps
        : [`No sufficient source material found for: ${question}`];
    return {
      answer: answer || "I could not find reliable source material for this question.",
      confidence: "low",
      citations,
      gaps: summaries.map((summary) => toGapSignal(summary, question, citedSectionIds)),
      ...(flowId ? { flowId } : {})
    };
  }

  return {
    answer,
    confidence: structured?.confidence ?? "medium",
    citations,
    ...(flowId ? { flowId } : {})
  };
}

interface StructuredAnswer {
  answer: string;
  confidence: Confidence;
  isKnowledgeGap: boolean;
  gaps: string[];
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
  const candidate = parsed as { answer?: unknown; confidence?: unknown; isKnowledgeGap?: unknown; gaps?: unknown };
  if (typeof candidate.answer !== "string" || !isConfidence(candidate.confidence)) {
    return undefined;
  }
  const isKnowledgeGap = candidate.isKnowledgeGap === true;
  return {
    answer: candidate.answer,
    confidence: isKnowledgeGap ? "low" : candidate.confidence,
    isKnowledgeGap,
    gaps: Array.isArray(candidate.gaps)
      ? candidate.gaps.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
      : []
  };
}

function toCitation(section: RetrievedSection): Citation {
  return {
    documentId: section.documentId,
    sectionId: section.sectionId,
    path: section.path,
    heading: section.heading,
    anchor: section.anchor,
    excerpt: section.content.slice(0, 280)
  };
}

function toGapSignal(summary: string, question: string, citedSectionIds: string[]): KnowledgeGapSignal {
  return { summary, question, confidence: "low", citedSectionIds };
}

function isConfidence(value: unknown): value is Confidence {
  return value === "high" || value === "medium" || value === "low" || value === "unknown";
}

function extractJson(stdout: string): unknown {
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
