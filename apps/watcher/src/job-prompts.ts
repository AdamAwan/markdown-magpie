import type {
  AiJob,
  AnswerQuestionJobInput,
  AnswerQuestionJobOutput,
  Citation,
  CrunchKnowledgeBaseJobOutput,
  DraftMarkdownProposalJobOutput,
  KnowledgeGapSignal,
  SummarizeGapJobOutput
} from "@magpie/core";
import { buildJobPrompt } from "@magpie/prompts";

export function buildPrompt(job: AiJob): string {
  return buildJobPrompt(job);
}

export function parseJobOutput(job: AiJob, stdout: string): unknown {
  const parsed = extractJson(stdout);
  if (job.type === "answer_question") {
    return assertAnswerQuestionOutput(parsed, job.input as AnswerQuestionJobInput);
  }

  if (job.type === "summarize_gap") {
    return assertSummarizeGapOutput(parsed);
  }

  if (job.type === "draft_markdown_proposal") {
    return assertDraftMarkdownProposalOutput(parsed);
  }

  if (job.type === "crunch_knowledge_base") {
    return assertCrunchKnowledgeBaseOutput(parsed);
  }

  return parsed;
}

function extractJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first === -1 || last === -1 || last <= first) {
      throw new Error("Agent output did not contain a JSON object");
    }

    return JSON.parse(trimmed.slice(first, last + 1));
  }
}

// The model returns only { answer, confidence, isKnowledgeGap, gaps[] } — the
// same shape the direct retrieval path uses. Citations are not trusted from the
// model; they are derived in code from the context sections the job already
// carries, so attribution stays reliable and the two answer paths share one prompt.
function assertAnswerQuestionOutput(value: unknown, input: AnswerQuestionJobInput): AnswerQuestionJobOutput {
  if (!value || typeof value !== "object") {
    throw new Error("answer_question output must be an object");
  }

  const candidate = value as { answer?: unknown; confidence?: unknown; isKnowledgeGap?: unknown; gaps?: unknown };
  if (typeof candidate.answer !== "string" || !isConfidence(candidate.confidence)) {
    throw new Error("answer_question output does not match expected schema");
  }

  const isKnowledgeGap = candidate.isKnowledgeGap === true;
  const citations = input.context.map(toCitation);
  const output: AnswerQuestionJobOutput = {
    answer: candidate.answer,
    confidence: isKnowledgeGap ? "low" : candidate.confidence,
    citations
  };

  if (isKnowledgeGap) {
    output.gaps = toGapSignals(candidate.gaps, input.question, citations);
  }

  return output;
}

function toCitation(section: AnswerQuestionJobInput["context"][number]): Citation {
  return {
    documentId: section.path,
    sectionId: section.sectionId,
    path: section.path,
    heading: section.heading,
    anchor: section.heading.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    excerpt: section.content.slice(0, 280)
  };
}

// Turns the model's gap strings into knowledge-gap signals, each tagged with the
// question and the sections that were cited. Falls back to one generated summary
// when the model flagged a gap but listed no specific summaries.
function toGapSignals(gaps: unknown, question: string, citations: Citation[]): KnowledgeGapSignal[] {
  const summaries = Array.isArray(gaps)
    ? gaps.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
    : [];
  const effective = summaries.length > 0 ? summaries : [`No sufficient source material found for: ${question}`];
  const citedSectionIds = citations.map((citation) => citation.sectionId);
  return effective.map((summary) => ({ summary, question, confidence: "low", citedSectionIds }));
}

function assertSummarizeGapOutput(value: unknown): SummarizeGapJobOutput {
  const candidate = value as Partial<SummarizeGapJobOutput>;
  if (!candidate || typeof candidate.summary !== "string" || typeof candidate.priority !== "number") {
    throw new Error("summarize_gap output does not match expected schema");
  }

  return candidate as SummarizeGapJobOutput;
}

function assertDraftMarkdownProposalOutput(value: unknown): DraftMarkdownProposalJobOutput {
  const candidate = value as Partial<DraftMarkdownProposalJobOutput>;
  if (
    !candidate ||
    typeof candidate.title !== "string" ||
    typeof candidate.targetPath !== "string" ||
    typeof candidate.markdown !== "string"
  ) {
    throw new Error("draft_markdown_proposal output does not match expected schema");
  }

  return candidate as DraftMarkdownProposalJobOutput;
}

function assertCrunchKnowledgeBaseOutput(value: unknown): CrunchKnowledgeBaseJobOutput {
  const candidate = value as Partial<CrunchKnowledgeBaseJobOutput>;
  if (!candidate || typeof candidate.summary !== "string" || !Array.isArray(candidate.operations)) {
    throw new Error("crunch_knowledge_base output does not match expected schema");
  }

  for (const operation of candidate.operations) {
    if (
      !operation ||
      typeof operation.title !== "string" ||
      !Array.isArray(operation.writes) ||
      !Array.isArray(operation.deletes) ||
      operation.writes.some((write) => typeof write?.path !== "string" || typeof write?.content !== "string")
    ) {
      throw new Error("crunch_knowledge_base operation does not match expected schema");
    }
  }

  return candidate as CrunchKnowledgeBaseJobOutput;
}

function isConfidence(value: unknown): value is AnswerQuestionJobOutput["confidence"] {
  return value === "high" || value === "medium" || value === "low" || value === "unknown";
}
