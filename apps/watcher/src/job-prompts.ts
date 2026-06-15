import type {
  AiJob,
  AnswerQuestionJobInput,
  AnswerQuestionJobOutput,
  DraftMarkdownProposalJobInput,
  DraftMarkdownProposalJobOutput,
  SummarizeGapJobInput,
  SummarizeGapJobOutput
} from "@magpie/core";

export function buildPrompt(job: AiJob): string {
  if (job.type === "answer_question") {
    return answerQuestionPrompt(job.input as AnswerQuestionJobInput);
  }

  if (job.type === "summarize_gap") {
    return summarizeGapPrompt(job.input as SummarizeGapJobInput);
  }

  if (job.type === "draft_markdown_proposal") {
    return draftMarkdownProposalPrompt(job.input as DraftMarkdownProposalJobInput);
  }

  return genericPrompt(job);
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

  return parsed;
}

function answerQuestionPrompt(input: AnswerQuestionJobInput): string {
  return `You are answering a question using a Markdown knowledge base.

Rules:
- Use only the provided context.
- If the context is insufficient, say that reliable source material was not found.
- Return JSON only. Do not wrap it in Markdown.
- Every citation must refer to a provided context section.

Return this JSON shape:
{
  "answer": "string",
  "confidence": "high | medium | low",
  "citations": [
    {
      "documentId": "string",
      "sectionId": "string",
      "path": "string",
      "heading": "string",
      "anchor": "string",
      "excerpt": "string"
    }
  ],
  "gap": {
    "summary": "string",
    "question": "string",
    "confidence": "low",
    "citedSectionIds": []
  }
}

Omit "gap" when the answer is supported by context.

Question:
${input.question}

Context:
${JSON.stringify(input.context, null, 2)}`;
}

function summarizeGapPrompt(input: SummarizeGapJobInput): string {
  return `Summarize these unanswered or weakly answered knowledge base questions.

Return JSON only:
{
  "summary": "string",
  "priority": 1,
  "rationale": "string"
}

Input:
${JSON.stringify(input, null, 2)}`;
}

function draftMarkdownProposalPrompt(input: DraftMarkdownProposalJobInput): string {
  return `Draft a Markdown knowledge base proposal for this gap.

Rules:
- Return JSON only.
- Markdown must be reviewable and conservative.
- Use sourceContext when present as raw material for improving the destination knowledge base.
- Cite source file paths, URLs, or agent/internet source names in the rationale.
- Include frontmatter with title and status: draft.

Return JSON:
{
  "title": "string",
  "targetPath": "string",
  "markdown": "string",
  "rationale": "string"
}

Input:
${JSON.stringify(input, null, 2)}`;
}

function genericPrompt(job: AiJob): string {
  return `Complete this Markdown Magpie AI job. Return JSON only.

Job:
${JSON.stringify(job, null, 2)}`;
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

function isConfidence(value: unknown): value is AnswerQuestionJobOutput["confidence"] {
  return value === "high" || value === "medium" || value === "low" || value === "unknown";
}
