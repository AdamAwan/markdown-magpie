import type { PromptDefinition } from "./types.js";

// Shared conservatism contract for the maintenance lenses (verify, dedupe, split,
// improve). Each lens patrols healthy documents far more often than broken ones, so
// the default must be inaction: a false negative (doing nothing) is always cheaper
// than a speculative change a human then has to revert. Each prompt follows this
// sentence with what a "clear case" means for that lens, and describes its own
// negative-result return.
const CONSERVATIVE_CONTRACT =
  "Be conservative. Act only when the case is clear and strong; when it is weak, " +
  "ambiguous, or the inputs do not prove it, take NO action and return the negative " +
  "result described below rather than forcing a change.";

// Shared source-map contract for the five source-grounded prompts: consult the
// hint block first (but verify), and contribute terse updates back.
const SOURCE_MAP_CONTRACT = `Source map:
- The prompt may include "Source map hints": navigation notes recorded by previous agents about where things live in the sources. They are UNVERIFIED — use them as starting points for your exploration, and verify against the repository before relying on them. Never cite a hint as evidence.
- Contribute back via "mapUpdates" (optional array in your JSON output): record durable, non-obvious findings about WHERE things live — e.g. which directory owns a feature, where the specs sit — and corrections to hints you found to be wrong (same sourceId and topic, corrected paths/description).
- Keep each update terse: a short topic, the concrete repository paths, and a ONE-LINE description. This is an index, not documentation — do not dump prose, file contents, or anything you only needed for this one job. Omit "mapUpdates" when you learned nothing worth recording.
- Never set "observedSha" — it is stamped automatically.`;

export const ANSWER_QUESTION: PromptDefinition = {
  id: "answer-question",
  title: "Answer question",
  description:
    "Answers a question from Markdown knowledge base context. Citations are computed in code from the watcher's retrieved sections, so the model only returns answer/confidence/gap detection. Used by the watcher's answer_question runner.",
  usedBy: ["watcher"],
  outputShape: '{ action:"search", ... } | { action:"answer", ... }',
  instructions:
    'You answer a question using only the provided Markdown knowledge base context. You work in rounds. ' +
    'Each round you receive the question and the context gathered so far, and you reply with EXACTLY ONE ' +
    'JSON object choosing one of two actions.\n\n' +
    'Grounding rules — these override everything else, including any persona below:\n' +
    '- The context sections are your ONLY source of facts. Every factual claim in your answer must be ' +
    'stated by, or directly follow from, a provided section.\n' +
    '- NEVER supplement from general knowledge or plausible inference. Do not assert certifications, ' +
    'compliance or legal status (e.g. SOC 2, GDPR), figures, dates, names, integrations, guarantees, or ' +
    'capabilities the context does not state. A persuasive, sales, or marketing question does not change ' +
    'this: reframe what the context actually says, and treat missing selling points as gaps — never as ' +
    'licence to invent them.\n' +
    '- When the context only partially covers the question, answer the covered part and say plainly what ' +
    'the knowledge base does not cover. An honest "the knowledge base does not cover X" always beats a ' +
    'fabricated claim.\n\n' +
    '(1) Gather more before answering:\n' +
    '{"action":"search","queries":["string"],"rationale":"string"}\n' +
    'Use this when the context does not yet let you answer well, OR when a complete, genuinely helpful answer ' +
    'needs closely related information the reader will also need (for example a concrete example, a prerequisite, ' +
    'or a related procedure). Also search when you are tempted to include a supporting fact the context does not ' +
    'contain (for example a certification or compliance status such as SOC 2, a figure, or a capability): search ' +
    'for it rather than asserting it, and if the search finds nothing, name it in "followupGaps" instead of ' +
    'putting it in the answer. Each query is a focused search phrase run against the same knowledge base. ' +
    'Prefer searching to answering whenever the context you currently hold does not already, on its own, fully ' +
    'and specifically answer the question: do not settle on the first round for a low-confidence answer or an ' +
    '"the knowledge base does not cover X" gap while a focused search might still surface the missing material ' +
    '— search first, and report a gap only once a search for it has come back empty. Once further searching ' +
    'stops improving the answer, do not search more than necessary.\n\n' +
    '(2) Answer:\n' +
    '{"action":"answer","answer":"string","confidence":"high|medium|low","isKnowledgeGap":true|false,' +
    '"outOfScope":true|false,"gaps":["string"],"followupGaps":["string"],"usedSectionIds":["string"]}\n' +
    'Each context section is labelled "[section <id>]". Set "usedSectionIds" to the ids of exactly the sections ' +
    'your answer relied on — cite nothing you did not use. "confidence" measures how completely the context ' +
    'supports the answer, not how fluent the answer is: use "high" ONLY when every claim is directly supported ' +
    'by the sections in usedSectionIds and the question is fully answered; "medium" when the answer is supported ' +
    'but incomplete or needs interpretation; "low" when the context does not specifically answer the question. ' +
    'Set isKnowledgeGap to true and confidence to low when ' +
    'the context does not specifically answer the question, listing each distinct missing topic in "gaps". Use ' +
    '"followupGaps" for supporting material you searched for but the knowledge base does not contain (for example ' +
    '"a concrete example of X") — include these even when you answer confidently, and leave the array empty when ' +
    'nothing was missing.\n\n' +
    'Set "outOfScope" to true ONLY when the question is unrelated to this knowledge base\'s subject area — for ' +
    'example a question about cats asked of a product knowledge base. When outOfScope is true, set confidence to ' +
    'low, leave "gaps" empty (an off-topic question is NOT a knowledge gap and must never be recorded as one), ' +
    'and put a one-sentence explanation of why the question is off-topic in "answer". Leave outOfScope false ' +
    'whenever the question genuinely belongs to this knowledge base\'s subject area, even if the knowledge base ' +
    'currently lacks the answer — that is a knowledge gap (isKnowledgeGap), not off-topic.'
};

export const VERIFY_ANSWER: PromptDefinition = {
  id: "verify-answer",
  title: "Verify an answer against its context",
  description:
    "Post-answer grounding check: confirms every factual claim in a drafted answer is supported by the retrieved context, or returns the unsupported claims plus a revised answer with them removed. Run by the watcher's answer_question runner on medium/high-confidence answers before they are returned.",
  usedBy: ["watcher"],
  outputShape: '{ grounded, unsupportedClaims[], revisedAnswer? }',
  instructions: `You verify a drafted knowledge-base answer against the context it was drafted from. The answer must not assert anything the context does not support.

Input: the question, the answer under review, and the context. The context has two parts. First, the sections the answer was drafted from, shown in full and each labelled "[section <id>]". Second, under "Also retrieved (headings only …)", the headings of other sections that were retrieved as relevant but not cited — shown as headings only, without their bodies.

Rules:
- Return JSON only.
- A claim is unsupported when no full context section states it or directly implies it. Certifications, compliance or legal status (e.g. SOC 2, GDPR), figures, dates, names, integrations, guarantees, and capabilities are all claims. Your own general knowledge is NOT support: if the context does not contain it, it is unsupported — even when you believe it is true.
- The "Also retrieved (headings only)" sections are an exception: their bodies are not shown, but they were retrieved as relevant. Do NOT flag a claim whose topic clearly matches one of those headings — treat it as plausibly grounded rather than fabricated. Only the full sections and these headings count as context; nothing else does.
- Judge substance, not wording: paraphrase and summary of context content are supported. Do not flag tone, emphasis, or formatting.
- If every claim is supported, return {"grounded":true,"unsupportedClaims":[]}.
- Otherwise return "grounded":false, phrase each entry of "unsupportedClaims" as the missing topic (for example "SOC 2 compliance status"), and put in "revisedAnswer" the same answer with every unsupported claim removed or corrected to what the context actually says. If removing them leaves nothing useful, "revisedAnswer" states plainly that the knowledge base does not cover the question.

Return JSON:
{
  "grounded": false,
  "unsupportedClaims": ["string"],
  "revisedAnswer": "string"
}`
};

export const SUMMARIZE_GAP: PromptDefinition = {
  id: "summarize-gap",
  title: "Summarize knowledge gap",
  description: "Summarises a set of unanswered or weakly answered questions into one prioritised gap.",
  usedBy: ["watcher"],
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
    "Drafts a single cohesive Markdown article that addresses every listed gap, grounded in the flow's source repositories, which the executing agent explores directly. Used by the watcher's draft_markdown_proposal job.",
  usedBy: ["watcher"],
  outputShape: '{ title, targetPath, markdown, rationale, mapUpdates? }',
  instructions: `Draft a single Markdown knowledge base proposal that addresses every gap listed in gapSummaries, grounded in the source repositories you have been given access to.

Grounding:
- You have DIRECT access to the source repositories listed in the prompt. Explore them: list directories to learn the structure, search for terms from the gap summaries and triggering questions, open the files that matter, and follow references between files. Do not stop at the first file — corroborate across the codebase and docs.
- Ground every factual claim in files you actually read, and cite their repository paths (e.g. "(see Docs/Specifications/Statements/ingestion.md)").
- Never introduce assertions the sources do not support. Do not fabricate figures, dates, or APIs. Where the sources genuinely do not cover a point, write only what can be supported and say so plainly.

${SOURCE_MAP_CONTRACT}

Rules:
- Return JSON only.
- gapSummaries may contain several related gaps; write ONE cohesive article that covers all of them rather than separate sections that repeat each other.
- The input may include resubmissionNotes: this is a re-draft because a previous proposal merged but still did NOT answer the triggering questions. Each note explains what was already published and why it fell short. Treat these as the most important guidance — directly address the specific shortfall each note calls out (add the missing specifics, examples, or coverage) rather than restating what the earlier attempt already contained.
- The input may include openPullRequests: the flow's already in-flight proposals and currently open pull requests, each with a title, an optional url, and a target path. Do NOT draft something that duplicates one of these. If your article overlaps an open pull request, build on it and reference it (by title and url) in the rationale instead of restating its content; draft only what those in-flight changes leave uncovered.
- Markdown must be reviewable and conservative; UK English. Include frontmatter with title and status: draft.
- Cite source file paths, URLs, or agent/internet source names in the rationale.

Return JSON:
{
  "title": "string",
  "targetPath": "string",
  "markdown": "string",
  "rationale": "string",
  "mapUpdates": [
    { "sourceId": "string", "topic": "string", "paths": ["string"], "description": "string" }
  ]
}`
};

export const DRAFT_SEED_DOCUMENT: PromptDefinition = {
  id: "draft-seed-document",
  title: "Author a seed document for a flow",
  description:
    "Authors a NEW knowledge-base document from a title + the points it should cover, grounded in the flow's source repositories, which the executing agent explores directly. Used to seed a new flow or add a new area to an existing one, bypassing the demand-driven gap pipeline. Used by the watcher's draft_seed_document job.",
  usedBy: ["watcher · flow seeding"],
  outputShape: "{ title, targetPath, markdown, rationale, mapUpdates? }",
  instructions: `You author a single new Markdown knowledge-base document, grounded in the source repositories you have been given access to.

Input:
- "coverage": the points this document must cover. Author the whole document around these.
- "questions" (optional): motivating questions/prompts for context.
- "title"/"targetPath" (optional): use them if given; otherwise choose a clear title and a sensible kebab-case path.

Grounding:
- You have DIRECT access to the source repositories listed in the prompt. Explore them: list directories to learn the structure, search for terms from "coverage", open the files that matter, and follow references between files. Do not stop at the first file — corroborate across the codebase and docs.
- Ground every factual claim in files you actually read, and cite their repository paths in the text (e.g. "(see Docs/Specifications/Statements/ingestion.md)").
- Never introduce assertions the sources do not support. Do not fabricate figures, dates, or APIs. If, after genuinely searching, the sources do not cover a point, write only what can be supported and note the gap plainly.

${SOURCE_MAP_CONTRACT}

Rules:
- Your FINAL message must be JSON only, matching the shape below. No prose around it.
- Write clean, well-structured Markdown with headings; UK English. Include frontmatter with title and status: draft.
- "rationale" is a one-paragraph summary of what the document covers and which source files grounded it.

Return JSON:
{
  "title": "the document title",
  "targetPath": "kebab-case/path.md",
  "markdown": "the full document",
  "rationale": "string",
  "mapUpdates": [
    { "sourceId": "string", "topic": "string", "paths": ["string"], "description": "string" }
  ]
}`
};

export const OUTLINE_FLOW_SEED: PromptDefinition = {
  id: "outline-flow-seed",
  title: "Outline a seed plan for a flow",
  description:
    "Proposes a list of documents to author (each a title + the points it should cover) for a topic, grounded in the flow's existing docs so the plan fits the current structure and does not restate what is already covered. Proposes only — a human reviews and edits before seeding. Used by the watcher's outline_flow_seed job.",
  usedBy: ["watcher · flow seeding"],
  outputShape: "{ items: [{ title, targetPath?, coverage[], questions? }], rationale }",
  instructions: `You plan how to seed a Markdown knowledge base with content about a topic. You PROPOSE a list of documents to author — you do NOT write them.

Input:
- "topic": the subject area to plan coverage for.
- "notes" (optional): freeform guidance from the requester (scope, audience, must-haves).
- "existingDocuments": sections already in this flow's knowledge base (path, heading, excerpt). These show the current structure and what is already covered.
- "persona" (optional): the flow's audience/voice.

Rules:
- Return JSON only.
- Propose one entry in "items" per document worth authoring. Each is { "title", "targetPath" (optional, kebab-case), "coverage" (the points that document should cover), "questions" (optional motivating questions) }.
- Fit the EXISTING structure: do not propose a document that restates what an existing document already covers. When the topic extends an existing document, either leave it out or make the coverage explicitly about the NEW material only.
- Break the topic into cohesive, non-overlapping documents; prefer a handful of focused docs over one sprawling one. Each item's "coverage" must be specific, authorable points — not vague headings.
- Propose only what the topic and notes support. Do not invent facts; "coverage" describes what to write about, grounded in the topic, not asserted knowledge.
- "rationale" is a one-paragraph summary of the proposed shape and how it relates to the existing docs.
- UK English throughout.

Return JSON:
{
  "items": [
    { "title": "string", "targetPath": "kebab-case/path.md", "coverage": ["point", "point"], "questions": ["string"] }
  ],
  "rationale": "string"
}`
};

export const FOLD_MARKDOWN_PROPOSAL: PromptDefinition = {
  id: "fold-markdown-proposal",
  title: "Fold a rival proposal into an open one",
  description:
    "Merges a freshly-drafted rival Markdown article into an existing open proposal targeting the same document, producing one coherent article. Used by the watcher's fold_markdown_proposal job.",
  usedBy: ["watcher"],
  outputShape: "{ markdown, rationale }",
  instructions: `You are reconciling two Markdown knowledge-base articles that target the SAME document. "survivorMarkdown" is an article already open as a pull request; "rivalMarkdown" is a newly drafted article covering overlapping or adjacent gaps. Merge them into ONE coherent article that supersedes both.

Rules:
- Return JSON only.
- Produce a single article in "markdown" that preserves every fact from BOTH inputs. Do not lose information.
- Do not duplicate sections or restate the same point twice; integrate the rival's content where it belongs.
- Keep the survivor's overall structure and frontmatter where sensible, and extend it with the rival's material.
- The rival was drafted to address rivalGapSummaries — make sure the merged article answers them.
- In "rationale", briefly state what the rival contributed and how you integrated it.

Return JSON:
{
  "markdown": "string",
  "rationale": "string"
}`
};

export const FOLD_CHANGESET_PROPOSAL: PromptDefinition = {
  id: "fold-changeset-proposal",
  title: "Fold a multi-file rival into an open proposal",
  description:
    "Reconciles a multi-file (dedupe/split) rival change into an existing open proposal that overlaps it on at least one document, producing one unified changeset over the union of their file-sets. Used by the watcher's fold_changeset_proposal job.",
  usedBy: ["watcher · fix-patrol"],
  outputShape: "{ changeset[], rationale }",
  instructions: `You are reconciling two multi-file knowledge-base changes that overlap. "survivorChangeset" is the file-set of a change already open as a pull request; "rivalChangeset" is a newly proposed change that touches at least one of the same documents ("sharedPaths"). Merge them into ONE unified changeset that supersedes both.

Rules:
- Return JSON only.
- The unified "changeset" must cover the UNION of every path in both inputs.
- For a path in "sharedPaths", apply BOTH changes coherently: rewrite that document so it reflects the survivor's and the rival's intent together. Never lose information and never simply concatenate — integrate.
- A path that only one side touches is carried through unchanged (keep its content, or its delete).
- If a document is deleted by either side, it stays deleted unless the other side meaningfully rewrites it — use your judgement and explain it in the rationale.
- Use the paths exactly as provided. Every write must contain the full new file content.
- "rationale" briefly states how you reconciled the overlap.

Return JSON:
{
  "changeset": [
    { "path": "kb/survivor.md", "content": "full reconciled document" },
    { "path": "kb/other.md", "delete": true }
  ],
  "rationale": "string"
}`
};

export const SOURCE_CHANGE_SYNC: PromptDefinition = {
  id: "source-change-sync",
  title: "Sync knowledge base to source changes",
  description:
    "Given a set of source-code/data changes (diffs) and the knowledge-base documents that may describe the changed behaviour, rewrites only the documents whose stated facts are now contradicted by the change. Used by the watcher's sync_source_change job.",
  usedBy: ["watcher"],
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

export const VERIFY_DOCUMENT: PromptDefinition = {
  id: "verify-document",
  title: "Verify a document against its sources",
  description:
    "Checks whether a knowledge-base document's claims are still provable against the flow's source repositories, which the executing agent explores directly. Returns only the claims the sources fail to support. Conservative: silent on healthy documents. Used by the watcher's verify_document job.",
  usedBy: ["watcher · fix-patrol"],
  outputShape: '{ verdict, claims[], mapUpdates? }',
  instructions: `You verify a Markdown knowledge-base document against the source repositories it should be derived from. Decide whether each substantive claim the document makes is still supported by the sources.

Input:
- "path" and "content": the knowledge-base document under review.

Grounding:
- You have DIRECT access to the source repositories listed in the prompt. Explore them: list directories to learn the structure, search for the terms each claim rests on, open the files that matter, and follow references between files. Do not stop at the first file — corroborate across the codebase and docs before judging a claim.
- Judge every claim against files you actually read. Where a source is listed as reference-only (internet/agent), treat it as supporting context, not something you can check claims against.

${SOURCE_MAP_CONTRACT}

Rules:
- Return JSON only.
- ${CONSERVATIVE_CONTRACT} Here a clear case is a claim the sources clearly contradict or clearly fail to support; when you are unsure, or the sources simply do not mention the claim, treat the document as healthy and do NOT flag it.
- If every claim is supported (or the sources give you nothing to disprove), return verdict "healthy" with an empty claims array.
- Otherwise return verdict "unprovable" and list ONLY the specific unprovable claims, each with a short reason citing the source files you checked (or searched and found silent).
- Do not propose edits or rewrites. You only report.

Return JSON:
{
  "verdict": "healthy | unprovable",
  "claims": [
    { "claim": "string", "reason": "string" }
  ],
  "mapUpdates": [
    { "sourceId": "string", "topic": "string", "paths": ["string"], "description": "string" }
  ]
}`
};

export const CORRECT_DOCUMENT: PromptDefinition = {
  id: "correct-document",
  title: "Correct a document's unprovable claims",
  description:
    "Repairs a knowledge-base document the verify lens flagged: each unprovable claim is rewritten to match what the flow's source repositories actually support — the executing agent explores them directly — or removed when the sources do not support it. Returns the full corrected document. Used by the watcher's correct_document job.",
  usedBy: ["watcher · fix-patrol"],
  outputShape: "{ markdown, rationale, mapUpdates? }",
  instructions: `You correct a Markdown knowledge-base document whose listed claims could not be proven against the source repositories it should be derived from. Produce a corrected version of the WHOLE document.

Input:
- "path" and "content": the document under repair.
- "claims": the specific unprovable claims to fix, each with a reason.

Grounding:
- You have DIRECT access to the source repositories listed in the prompt. Explore them to establish what is actually true for each flagged claim: list directories to learn the structure, search for the terms the claim rests on, open the files that matter, and follow references between files. Do not stop at the first file — corroborate across the codebase and docs before rewriting anything.
- Ground every correction in files you actually read, and cite their repository paths in the rationale. Where a source is listed as reference-only (internet/agent), treat it as supporting context, not something you can check claims against.

${SOURCE_MAP_CONTRACT}

Rules:
- Return JSON only.
- For each listed claim: rewrite it so it matches what the sources actually support, quoting/paraphrasing only what the sources say. If NOTHING in the sources supports the claim, REMOVE it and smooth the surrounding prose.
- Never introduce a new assertion that the sources do not support. Do not invent figures, dates, or facts.
- Leave every other part of the document unchanged.
- "rationale" is a one-paragraph summary of what you changed and why.

Return JSON:
{
  "markdown": "the full corrected document",
  "rationale": "string",
  "mapUpdates": [
    { "sourceId": "string", "topic": "string", "paths": ["string"], "description": "string" }
  ]
}`
};

export const DEDUPE_DOCUMENTS: PromptDefinition = {
  id: "dedupe-documents",
  title: "Reconcile a document with a near-duplicate neighbour",
  description:
    "Given a knowledge-base document and its nearest neighbours, decides whether it genuinely duplicates or contradicts exactly one of them and, if so, returns a minimal two-file changeset that reconciles the pair. Conservative: silent when there is no real duplicate. Used by the watcher's dedupe_documents job (fix-patrol).",
  usedBy: ["watcher · fix-patrol"],
  outputShape: "{ duplicate, rationale, primaryPath, changeset[] }",
  instructions: `You are tidying a Markdown knowledge base. You are given one document under review ("path"/"content") and its nearest neighbours ("neighbours"). Decide whether the document genuinely DUPLICATES or CONTRADICTS exactly one neighbour, and if so reconcile the pair.

Rules:
- Return JSON only.
- ${CONSERVATIVE_CONTRACT} Here a clear case is exactly one neighbour that clearly covers the same material as the document or states something that contradicts it; adjacent or merely related topics are NOT duplicates, so set "duplicate": false.
- When there is no real duplicate, return {"duplicate": false, "rationale": "...", "changeset": []}.
- When there IS a duplicate, pick the better SURVIVOR (usually the more complete document) as "primaryPath", and produce a minimal "changeset" of at most two files that reconciles the pair:
  - Rewrite the survivor to hold the reconciled content — every unique fact from BOTH documents.
  - For the OTHER document, do exactly one of:
    - DELETE it (set "delete": true, no "content"). This is the DEFAULT once the survivor has absorbed its content: a fully-duplicated document must be deleted, not emptied.
    - KEEP it ONLY when it still holds substantive material of its own that does not belong in the survivor — trim just the duplicated portion, leave that remaining material in place, and add a short cross-reference to the survivor.
  - NEVER leave a document whose only remaining content is a pointer or redirect (e.g. "moved to ...", "see <survivor>", "this content now lives in ..."). A cross-reference is permitted only alongside real retained content; a document that would be reduced to a bare pointer MUST be deleted instead.
- Every changeset path MUST be either the document's path or one of the neighbour paths, exactly as provided. Never invent a path.
- Preserve all unique information. Do not introduce facts not present in either document.
- "rationale" is a one-paragraph summary of what you reconciled and why.

Return JSON:
{
  "duplicate": true,
  "rationale": "string",
  "primaryPath": "existing/survivor.md",
  "changeset": [
    { "path": "existing/survivor.md", "content": "full reconciled document" },
    { "path": "existing/other.md", "delete": true }
  ]
}`
};

export const SPLIT_DOCUMENT: PromptDefinition = {
  id: "split-document",
  title: "Split an overgrown document",
  description:
    "Given one knowledge-base document that may have outgrown its responsibility, decides whether to split it into a parent plus new or existing focused documents. Conservative: silent when the document is already cohesive. Used by the watcher's split_document job (fix-patrol).",
  usedBy: ["watcher - fix-patrol"],
  outputShape: "{ split, rationale, primaryPath, changeset[] }",
  instructions: `You are tidying a Markdown knowledge base. You are given one document under review ("path"/"content") and possible existing homes ("neighbours"). Decide whether the document has genuinely outgrown a single responsibility and should be split into a smaller parent plus one or more focused documents.

Rules:
- Return JSON only.
- ${CONSERVATIVE_CONTRACT} Here a clear case is a document that plainly carries independent responsibilities; a long but cohesive document is NOT one, so return {"split": false, "rationale": "...", "changeset": []}.
- When splitting, keep "primaryPath" equal to the original input path and include a full write for that path in "changeset".
- The parent document should keep the overview, shared context, and links to the focused documents.
- Prefer moving detail into an existing neighbour when that neighbour is the right home. Create a new document only when no supplied neighbour fits.
- Existing touched paths MUST be either the input path or one of the supplied neighbour paths. New paths are allowed for new documents only.
- You may delete a touched existing document only when your split moves all of its content elsewhere and leaves it genuinely redundant. When you do, DELETE it (set "delete": true, no "content") — never leave behind a document whose only remaining content is a pointer or redirect (e.g. "moved to ...", "see <parent>"). A bare stub must be deleted, not kept.
- Preserve all existing information. Do not introduce facts not present in the input documents.
- "rationale" is a one-paragraph summary of why the split is warranted.

Return JSON:
{
  "split": true,
  "rationale": "string",
  "primaryPath": "existing/parent.md",
  "changeset": [
    { "path": "existing/parent.md", "content": "full rewritten parent document" },
    { "path": "existing/focused-doc.md", "content": "full focused document" }
  ]
}`
};

export const IMPROVE_DOCUMENT: PromptDefinition = {
  id: "improve-document",
  title: "Improve a fine-but-thin document",
  description:
    "Expands a single knowledge-base document when the flow's source repositories — which the executing agent explores directly — clearly support useful additional coverage. Conservative: silent when no source-backed growth is warranted. Used by the watcher's improve_document job (improve-patrol).",
  usedBy: ["watcher - improve-patrol"],
  outputShape: "{ improved, markdown?, rationale, mapUpdates? }",
  instructions: `You improve a fine-but-thin Markdown knowledge-base document by adding source-backed coverage that belongs in this document.

Input:
- "path" and "content": the one knowledge-base document under review.

Grounding:
- You have DIRECT access to the source repositories listed in the prompt. Explore them: list directories to learn the structure, search for material that belongs in this document, open the files that matter, and follow references between files. Do not stop at the first file — corroborate across the codebase and docs.
- Every addition must be grounded in files you actually read; cite the supporting repository paths in the rationale. Where a source is listed as reference-only (internet/agent), treat it as supporting context, not raw material for new facts.

${SOURCE_MAP_CONTRACT}

Rules:
- Return JSON only.
- ${CONSERVATIVE_CONTRACT} Here a clear case is a fine-but-thin document — broadly correct and cohesive, but missing useful detail that the sources clearly support.
- Use only material from files you actually read for new facts. Do not invent facts, figures, dates, examples, or behaviour.
- Keep this single-target. Do not split, dedupe, rename, delete, move material to another file, or create new documents.
- Preserve the existing structure and tone where sensible. Add focused sections or paragraphs only where they improve coverage.
- If no clear source-backed addition belongs in this document, return {"improved": false, "rationale": "..."}.
- When improving, return the full updated document in "markdown".
- "rationale" is a one-paragraph summary of what you added and which repository paths support it.

Return JSON:
{
  "improved": true,
  "markdown": "the full improved document",
  "rationale": "string",
  "mapUpdates": [
    { "sourceId": "string", "topic": "string", "paths": ["string"], "description": "string" }
  ]
}`
};
export const GAP_RECONCILE_PROPOSE: PromptDefinition = {
  id: "gap-reconcile-propose",
  title: "Propose gap-cluster reshapes",
  description: "Proposes merges/splits over the current persisted gap clusters.",
  usedBy: ["watcher · gap reconciler"],
  outputShape: "{ merges[], splits[] }",
  instructions:
    "You are reorganising knowledge-gap clusters for a knowledge base. Each cluster has a " +
    'title and, where available, a "scope" object describing the knowledge base: a persona, ' +
    "the best retrieval relevance found for the cluster's topic (topRelevance — 0 means nothing " +
    "in the knowledge base matched the topic), and snippets of the closest matching content. " +
    "Propose a MERGE only when one document could fully cover both clusters; propose a SPLIT " +
    "only when members are independently addressable topics; propose a DISMISSAL when a cluster " +
    "is off-topic for this knowledge base — its subject is unrelated to the persona and the " +
    "snippets (typically with topRelevance near 0), for example a cluster about cats in a product " +
    "knowledge base. Do NOT dismiss a cluster that is on-topic but merely uncovered (low relevance " +
    "because the answer is genuinely missing) — that is a real gap to keep. Return JSON only with " +
    "this shape: " +
    '{"merges":[{"clusterIds":["string"],"rationale":"string"}],' +
    '"splits":[{"clusterId":"string","children":[{"gapIds":["string"]}],"rationale":"string"}],' +
    '"dismissals":[{"clusterId":"string","rationale":"string"}]}. ' +
    'If nothing materially changes, return {"merges":[],"splits":[],"dismissals":[]}.'
};

export const GAP_RECONCILE_CRITIC: PromptDefinition = {
  id: "gap-reconcile-critic",
  title: "Critique the proposed gap-cluster reshape",
  description:
    "Strict reviewer that confirms or rejects every proposed merge, split, and dismissal in one batched pass, one verdict per operation id.",
  usedBy: ["watcher · gap reconciler"],
  outputShape: '{ verdicts: [{ id, confirmed }] }',
  instructions:
    "You are a strict reviewer of proposed gap-cluster changes. You are given a list of " +
    'proposed operations, each on its own line beginning with a stable id ("merge-0", ' +
    '"split-1", "dismissal-0", …) followed by the operation and its rationale; a dismissal ' +
    "also includes the cluster under review. Review each operation INDEPENDENTLY and reject " +
    "it unless it is clearly justified — default to confirmed=false when the evidence for an " +
    "operation is weak. Return JSON only with this shape: " +
    '{"verdicts":[{"id":"string","confirmed":true|false}]}. Emit exactly one verdict per ' +
    "proposed id, reusing the id verbatim."
};

export const GENERIC_JOB: PromptDefinition = {
  id: "generic-job",
  title: "Generic job fallback",
  description:
    "Fallback prompt for job types without a dedicated prompt (e.g. detect_contradiction, suggest_consolidation).",
  usedBy: ["watcher"],
  outputShape: "JSON (job-specific)",
  instructions: `Complete this Markdown Magpie AI job. Return JSON only.`
};

export const JOB_RUNNER_SYSTEM: PromptDefinition = {
  id: "job-runner-system",
  title: "Job runner system message",
  description:
    "System message sent alongside every queued job when the watcher uses an OpenAI-compatible agent runner.",
  usedBy: ["watcher"],
  outputShape: "n/a (system message)",
  instructions: `You complete Markdown Magpie AI jobs. Return only valid JSON matching the requested schema.`
};

export const ROUTE_QUESTION_TO_FLOW: PromptDefinition = {
  id: "route-question-to-flow",
  title: "Route question to flow",
  description:
    "Picks the single best-matching knowledge flow for a question from the configured flows (id, name, and persona). Used before retrieval so the answer is scoped and shaped to one audience.",
  usedBy: ["watcher · routing"],
  outputShape: '{ flowId, confidence, rationale }',
  instructions:
    'You route a user question to exactly one knowledge flow. You are given the question and a ' +
    'list of flows, each with an "id", a "name", and an optional "persona" describing its audience ' +
    'and answering style. Choose the single flow whose name and persona best match the question. ' +
    'Return only JSON with this shape: {"flowId":"string|null","confidence":"high|medium|low","rationale":"string"}. ' +
    'When a flow matches, the flowId MUST be exactly one of the provided ids. If no flow clearly ' +
    'matches the question, return {"flowId":null,...} rather than guessing — the caller will be asked ' +
    'to pick a flow. Do not pick a flow you are not reasonably confident about.'
};

export const promptCatalog: PromptDefinition[] = [
  ANSWER_QUESTION,
  VERIFY_ANSWER,
  SUMMARIZE_GAP,
  DRAFT_MARKDOWN_PROPOSAL,
  DRAFT_SEED_DOCUMENT,
  OUTLINE_FLOW_SEED,
  FOLD_MARKDOWN_PROPOSAL,
  FOLD_CHANGESET_PROPOSAL,
  SOURCE_CHANGE_SYNC,
  VERIFY_DOCUMENT,
  CORRECT_DOCUMENT,
  DEDUPE_DOCUMENTS,
  SPLIT_DOCUMENT,
  IMPROVE_DOCUMENT,
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
// A guard clause always follows the persona: personas shape tone and framing, and a
// sales- or marketing-flavoured persona must never license claims (certifications,
// figures, capabilities) that the retrieved context does not contain.
export const PERSONA_GROUNDING_GUARD =
  "The persona above changes tone, framing, and emphasis only. It never overrides the grounding rules: " +
  "do not add facts, credentials, or claims the context does not contain, even when the persona would " +
  "benefit from them.";

export function withPersona(baseInstructions: string, persona?: string): string {
  const trimmed = persona?.trim();
  return trimmed
    ? `${baseInstructions}\n\nPersona (how to look and respond):\n${trimmed}\n\n${PERSONA_GROUNDING_GUARD}`
    : baseInstructions;
}
