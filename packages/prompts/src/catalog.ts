import type { PromptDefinition } from "./types.js";

export const ANSWER_QUESTION_QUEUE: PromptDefinition = {
  id: "answer-question-queue",
  title: "Answer question (queue mode)",
  description:
    "Answers a question from Markdown context and asks the model to produce its own citations. Used by queued answer_question jobs.",
  usedBy: ["watcher · queue mode"],
  outputShape: '{ answer, confidence, citations[], gaps[] }',
  instructions: `You are answering a question using a Markdown knowledge base.

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
  "gaps": [
    {
      "summary": "string",
      "question": "string",
      "confidence": "low",
      "citedSectionIds": []
    }
  ]
}

List one entry in "gaps" for each distinct piece of missing knowledge — a question that asks
about several unrelated topics should produce one gap per unanswered topic. Use an empty array
or omit "gaps" when the answer is fully supported by context.`
};

export const ANSWER_QUESTION_DIRECT: PromptDefinition = {
  id: "answer-question-direct",
  title: "Answer question (direct mode)",
  description:
    "Answers a question from Markdown context; citations are computed in code from search ranking, so the model only returns answer/confidence/gap detection. Used by the retrieval answerQuestion path.",
  usedBy: ["api · direct mode (retrieval)"],
  outputShape: '{ answer, confidence, isKnowledgeGap, gaps[] }',
  instructions:
    'Answer using only the provided Markdown knowledge base context. Return only JSON with this shape: ' +
    '{"answer":"string","confidence":"high|medium|low","isKnowledgeGap":true|false,"gaps":["string"]}. ' +
    'Set isKnowledgeGap to true and confidence to low when the context does not specifically answer the question. ' +
    'List each distinct piece of missing knowledge as its own entry in "gaps" — a question that asks about several ' +
    'unrelated topics should produce one gap per unanswered topic. Use an empty array when the answer is fully supported.'
};

export const SUMMARIZE_GAP: PromptDefinition = {
  id: "summarize-gap",
  title: "Summarize knowledge gap",
  description: "Summarises a set of unanswered or weakly answered questions into one prioritised gap.",
  usedBy: ["watcher · queue mode"],
  outputShape: '{ summary, priority, rationale }',
  instructions: `Summarize these unanswered or weakly answered knowledge base questions.

Return JSON only:
{
  "summary": "string",
  "priority": 1,
  "rationale": "string"
}`
};

export const DRAFT_MARKDOWN_PROPOSAL: PromptDefinition = {
  id: "draft-markdown-proposal",
  title: "Draft Markdown proposal",
  description:
    "Drafts a single cohesive Markdown article that addresses every listed gap. Used by both queued draft jobs and the API direct path.",
  usedBy: ["watcher · queue mode", "api · direct mode"],
  outputShape: '{ title, targetPath, markdown, rationale }',
  instructions: `Draft a single Markdown knowledge base proposal that addresses every gap listed in gapSummaries.

Rules:
- Return JSON only.
- gapSummaries may contain several related gaps; write ONE cohesive article that covers all of them rather than separate sections that repeat each other.
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
}`
};

export const CRUNCH_KNOWLEDGE_BASE: PromptDefinition = {
  id: "crunch-knowledge-base",
  title: "Crunch knowledge base",
  description:
    "Proposes structural maintenance (consolidate/split/rewrite) over the Markdown knowledge base. Used by both queued crunch jobs and the API direct path.",
  usedBy: ["watcher · queue mode", "api · direct mode"],
  outputShape: '{ summary, operations[], rationale }',
  instructions: `You are tidying a fragmented Markdown knowledge base. Propose structural maintenance only — do not invent new facts.

Goal:
- CONSOLIDATE documents that overlap or are too small and scattered into a single cohesive document.
- SPLIT documents that have grown large and cover several unrelated topics into focused documents.
- Preserve all existing information. Only reorganize, merge, and lightly rewrite headings.

Rules:
- Return JSON only.
- Every operation must list the source paths it reorganizes, the files to write (full new content), and the files to delete.
- Use existing document paths exactly as provided in the input.
- If the knowledge base is already tidy, return an empty operations array.

Return JSON:
{
  "summary": "string",
  "operations": [
    {
      "kind": "consolidate | split | rewrite",
      "title": "string",
      "reason": "string",
      "sources": ["existing/path.md"],
      "writes": [{ "path": "new/path.md", "content": "string" }],
      "deletes": ["existing/path.md"]
    }
  ],
  "rationale": "string"
}`
};

export const GAP_CLUSTERING: PromptDefinition = {
  id: "gap-clustering",
  title: "Cluster related gaps",
  description: "Groups related knowledge-base gaps that a single Markdown article could resolve.",
  usedBy: ["api · direct mode"],
  outputShape: '{ clusters[] }',
  instructions:
    'Group related knowledge-base gaps that a single Markdown article could resolve. ' +
    'Two gaps belong together only when one proposal would naturally answer both. ' +
    'Return JSON only with this shape: {"clusters":[{"title":"string","summaries":["string"],"rationale":"string"}]}. ' +
    'Use the gap summary strings exactly as provided. Every input summary must appear in exactly one cluster. ' +
    'Prefer several small, focused clusters over one broad cluster.'
};

export const GENERIC_JOB: PromptDefinition = {
  id: "generic-job",
  title: "Generic job fallback",
  description:
    "Fallback prompt for job types without a dedicated prompt (e.g. detect_contradiction, suggest_consolidation).",
  usedBy: ["watcher · queue mode"],
  outputShape: "JSON (job-specific)",
  instructions: `Complete this Markdown Magpie AI job. Return JSON only.`
};

export const JOB_RUNNER_SYSTEM: PromptDefinition = {
  id: "job-runner-system",
  title: "Job runner system message",
  description:
    "System message sent alongside every queued job when the watcher uses an OpenAI-compatible agent runner.",
  usedBy: ["watcher · queue runner"],
  outputShape: "n/a (system message)",
  instructions: `You complete Markdown Magpie AI jobs. Return only valid JSON matching the requested schema.`
};

export const promptCatalog: PromptDefinition[] = [
  ANSWER_QUESTION_QUEUE,
  ANSWER_QUESTION_DIRECT,
  SUMMARIZE_GAP,
  DRAFT_MARKDOWN_PROPOSAL,
  CRUNCH_KNOWLEDGE_BASE,
  GAP_CLUSTERING,
  GENERIC_JOB,
  JOB_RUNNER_SYSTEM
];

export function getPrompt(id: string): PromptDefinition | undefined {
  return promptCatalog.find((prompt) => prompt.id === id);
}
