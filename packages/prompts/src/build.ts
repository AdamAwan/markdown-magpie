import type {
  AiJob,
  AnswerQuestionJobInput,
  CrunchKnowledgeBaseJobInput,
  DraftMarkdownProposalJobInput,
  SourceChangeSyncJobInput,
  SummarizeGapJobInput
} from "@magpie/core";
import {
  ANSWER_QUESTION,
  CRUNCH_KNOWLEDGE_BASE,
  DRAFT_MARKDOWN_PROPOSAL,
  GENERIC_JOB,
  SOURCE_CHANGE_SYNC,
  SUMMARIZE_GAP
} from "./catalog.js";

export function buildJobPrompt(job: AiJob): string {
  if (job.type === "answer_question") {
    const input = job.input as AnswerQuestionJobInput;
    // NOTE(Task 7): the watcher no longer uses this builder for answer_question.
    // It now does route -> retrieve -> answer itself (apps/watcher/src/runners/
    // chat.ts), applying the routed flow's persona and deriving citations from the
    // retrieved sections. This branch is retained only for the legacy AiJob-shaped
    // prompt surface and is removed with AiJob in Task 11.
    return `${ANSWER_QUESTION.instructions}\n\nQuestion:\n${input.question}\n\nCandidate flows:\n${JSON.stringify(input.flows, null, 2)}`;
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

  if (job.type === "sync_source_change") {
    return `${SOURCE_CHANGE_SYNC.instructions}\n\nInput:\n${JSON.stringify(job.input as SourceChangeSyncJobInput, null, 2)}`;
  }

  return `${GENERIC_JOB.instructions}\n\nJob:\n${JSON.stringify(job, null, 2)}`;
}
