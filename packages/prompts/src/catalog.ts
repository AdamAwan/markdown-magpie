import type { PromptDefinition } from "./types.js";

export const ANSWER_QUESTION: PromptDefinition = {
  id: "answer-question",
  title: "Answer question",
  description:
    "Answers a question from Markdown knowledge base context. Citations are computed in code from the retrieved sections (search ranking in direct mode, the job's context sections in queue mode), so the model only returns answer/confidence/gap detection. Shared by the direct retrieval path and queued answer_question jobs.",
  usedBy: ["api · direct mode (retrieval)", "watcher · queue mode"],
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

export const SOURCE_CHANGE_SYNC: PromptDefinition = {
  id: "source-change-sync",
  title: "Sync knowledge base to source changes",
  description:
    "Given a set of source-code/data changes (diffs) and the knowledge-base documents that may describe the changed behaviour, rewrites only the documents whose stated facts are now contradicted by the change. Used by both queued sync_source_change jobs and the API direct path.",
  usedBy: ["watcher · queue mode", "api · direct mode"],
  outputShape: '{ summary, operations[], rationale }',
  instructions: `You maintain a Markdown knowledge base that DESCRIBES an external source (code or data). The source has changed, and some knowledge-base documents may now state facts that the change has made wrong. Update those documents so they match the new reality.

Input:
- "changes": the source files that changed, each with a unified diff.
- "candidateDocuments": the knowledge-base documents retrieved as possibly affected. These are the ONLY documents you may edit.

Goal:
- For each candidate document, decide whether the source change contradicts or outdates anything it states (e.g. a threshold, date, default, behaviour, or rule that moved).
- Rewrite ONLY the documents that are now wrong, changing only the affected statements. Preserve all other content, structure, and tone.
- Do not edit a document the change does not affect.

Rules:
- Return JSON only.
- Only assert facts supported by the diffs. Do NOT invent new information or document behaviour the diff does not show.
- Use the candidate document paths exactly as provided. Every write must contain the full new file content. Do not delete documents.
- Use kind "rewrite" for every operation.
- If no candidate document is actually affected by the change, return an empty operations array.

Return JSON:
{
  "summary": "string",
  "operations": [
    {
      "kind": "rewrite",
      "title": "string",
      "reason": "string",
      "sources": ["existing/doc.md"],
      "writes": [{ "path": "existing/doc.md", "content": "string" }],
      "deletes": []
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

export const GAP_RECONCILE_PROPOSE: PromptDefinition = {
  id: "gap-reconcile-propose",
  title: "Propose gap-cluster reshapes",
  description: "Proposes merges/splits over the current persisted gap clusters.",
  usedBy: ["api · gap reconciler"],
  outputShape: "{ merges[], splits[] }",
  instructions:
    "You are reorganising knowledge-gap clusters. Propose a MERGE only when one " +
    "document could fully cover both clusters; propose a SPLIT only when members " +
    "are independently addressable topics. Return JSON only with this shape: " +
    '{"merges":[{"clusterIds":["string"],"rationale":"string"}],' +
    '"splits":[{"clusterId":"string","children":[{"gapIds":["string"]}],"rationale":"string"}]}. ' +
    'If nothing materially changes, return {"merges":[],"splits":[]}.'
};

export const GAP_RECONCILE_CRITIC: PromptDefinition = {
  id: "gap-reconcile-critic",
  title: "Critique a proposed gap-cluster reshape",
  description: "Strict reviewer that confirms or rejects a single proposed merge or split.",
  usedBy: ["api · gap reconciler"],
  outputShape: "{ confirmed, rationale }",
  instructions:
    "You are a strict reviewer of a proposed gap-cluster change. Reject unless the " +
    "change is clearly justified. Return JSON only with this shape: " +
    '{"confirmed":true|false,"rationale":"string"}. Default to confirmed=false when ' +
    "the evidence is weak."
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

export const ROUTE_QUESTION_TO_FLOW: PromptDefinition = {
  id: "route-question-to-flow",
  title: "Route question to flow",
  description:
    "Picks the single best-matching knowledge flow for a question from the configured flows (id, name, and persona). Used before retrieval so the answer is scoped and shaped to one audience.",
  usedBy: ["api · ask routing (direct + queue)"],
  outputShape: '{ flowId, confidence, rationale }',
  instructions:
    'You route a user question to exactly one knowledge flow. You are given the question and a ' +
    'list of flows, each with an "id", a "name", and an optional "persona" describing its audience ' +
    'and answering style. Choose the single flow whose name and persona best match the question. ' +
    'Return only JSON with this shape: {"flowId":"string","confidence":"high|medium|low","rationale":"string"}. ' +
    'The flowId MUST be exactly one of the provided ids. If no flow clearly matches, pick the closest ' +
    'one and set confidence to low.'
};

export const promptCatalog: PromptDefinition[] = [
  ANSWER_QUESTION,
  SUMMARIZE_GAP,
  DRAFT_MARKDOWN_PROPOSAL,
  CRUNCH_KNOWLEDGE_BASE,
  SOURCE_CHANGE_SYNC,
  GAP_CLUSTERING,
  GAP_RECONCILE_PROPOSE,
  GAP_RECONCILE_CRITIC,
  GENERIC_JOB,
  JOB_RUNNER_SYSTEM,
  ROUTE_QUESTION_TO_FLOW
];

export function getPrompt(id: string): PromptDefinition | undefined {
  return promptCatalog.find((prompt) => prompt.id === id);
}

// Appends a flow's persona snippet to a base answer prompt so the model knows the
// audience and answering style. Returns the base unchanged when no persona is set,
// keeping the single source of truth for the base instructions in this catalog.
export function withPersona(baseInstructions: string, persona?: string): string {
  const trimmed = persona?.trim();
  return trimmed ? `${baseInstructions}\n\nPersona (how to look and respond):\n${trimmed}` : baseInstructions;
}
