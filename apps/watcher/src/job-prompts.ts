import type {
  AiJob,
  AnswerQuestionJobOutput,
  CrunchKnowledgeBaseJobOutput,
  DraftMarkdownProposalJobOutput,
  SummarizeGapJobOutput
} from "@magpie/core";
import { buildJobPrompt } from "@magpie/prompts";

export function buildPrompt(job: AiJob): string {
  return buildJobPrompt(job);
}

export function parseJobOutput(job: AiJob, stdout: string): unknown {
  const parsed = extractJson(stdout);
  if (job.type === "answer_question") {
    return assertAnswerQuestionOutput(parsed);
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

function assertAnswerQuestionOutput(value: unknown): AnswerQuestionJobOutput {
  if (!value || typeof value !== "object") {
    throw new Error("answer_question output must be an object");
  }

  const candidate = value as Partial<AnswerQuestionJobOutput>;
  if (typeof candidate.answer !== "string" || !isConfidence(candidate.confidence) || !Array.isArray(candidate.citations)) {
    throw new Error("answer_question output does not match expected schema");
  }

  return candidate as AnswerQuestionJobOutput;
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
