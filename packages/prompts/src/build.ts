import type {
  AiJob,
  AnswerQuestionJobInput,
  CrunchKnowledgeBaseJobInput,
  DraftMarkdownProposalJobInput,
  SummarizeGapJobInput
} from "@magpie/core";
import {
  ANSWER_QUESTION_QUEUE,
  CRUNCH_KNOWLEDGE_BASE,
  DRAFT_MARKDOWN_PROPOSAL,
  GENERIC_JOB,
  SUMMARIZE_GAP
} from "./catalog.js";

export function buildJobPrompt(job: AiJob): string {
  if (job.type === "answer_question") {
    const input = job.input as AnswerQuestionJobInput;
    return `${ANSWER_QUESTION_QUEUE.instructions}\n\nQuestion:\n${input.question}\n\nContext:\n${JSON.stringify(input.context, null, 2)}`;
  }

  if (job.type === "summarize_gap") {
    return `${SUMMARIZE_GAP.instructions}\n\nInput:\n${JSON.stringify(job.input as SummarizeGapJobInput, null, 2)}`;
  }

  if (job.type === "draft_markdown_proposal") {
    return `${DRAFT_MARKDOWN_PROPOSAL.instructions}\n\nInput:\n${JSON.stringify(job.input as DraftMarkdownProposalJobInput, null, 2)}`;
  }

  if (job.type === "crunch_knowledge_base") {
    return `${CRUNCH_KNOWLEDGE_BASE.instructions}\n\nInput:\n${JSON.stringify(job.input as CrunchKnowledgeBaseJobInput, null, 2)}`;
  }

  return `${GENERIC_JOB.instructions}\n\nJob:\n${JSON.stringify(job, null, 2)}`;
}
