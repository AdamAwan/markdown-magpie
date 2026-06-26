import { z } from "zod";
import { PROPOSAL_STATUSES } from "@magpie/core";
import type {
  AnswerQuestionJobInput as CoreAnswerQuestionJobInput,
  AnswerQuestionJobOutput,
  CrunchKnowledgeBaseJobInput as CoreCrunchKnowledgeBaseJobInput,
  CrunchKnowledgeBaseJobOutput,
  CrunchPlan,
  DraftMarkdownProposalJobInput as CoreDraftMarkdownProposalJobInput,
  DraftMarkdownProposalJobOutput,
  FoldMarkdownProposalJobInput as CoreFoldMarkdownProposalJobInput,
  FoldMarkdownProposalJobOutput,
  FoldChangesetProposalJobInput as CoreFoldChangesetProposalJobInput,
  FoldChangesetProposalJobOutput,
  SourceChangeSyncJobInput as CoreSourceChangeSyncJobInput,
  SummarizeGapJobInput as CoreSummarizeGapJobInput,
  SummarizeGapJobOutput,
  VerifyDocumentJobInput as CoreVerifyDocumentJobInput,
  VerifyDocumentJobOutput,
  CorrectDocumentJobInput as CoreCorrectDocumentJobInput,
  CorrectDocumentJobOutput,
  DedupeDocumentsJobInput as CoreDedupeDocumentsJobInput,
  DedupeDocumentsJobOutput,
  SplitDocumentJobInput as CoreSplitDocumentJobInput,
  SplitDocumentJobOutput,
  ImproveDocumentJobInput as CoreImproveDocumentJobInput,
  ImproveDocumentJobOutput,
  ChangesetChange
} from "@magpie/core";
import { AI_PROVIDERS, type AiProviderName, type JobError } from "./types.js";

type ProviderInput<T> = T & { provider: AiProviderName };

const providerSchema = z.enum(AI_PROVIDERS);
const confidenceSchema = z.enum(["high", "medium", "low", "unknown"]);
const citationSchema = z.object({
  documentId: z.string(),
  sectionId: z.string(),
  path: z.string(),
  heading: z.string(),
  anchor: z.string(),
  commitSha: z.string().optional(),
  excerpt: z.string()
});
const gapSchema = z.object({
  summary: z.string(),
  question: z.string(),
  confidence: confidenceSchema,
  citedSectionIds: z.array(z.string())
});
const documentSchema = z.object({ path: z.string(), content: z.string() });

export const jobErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  category: z.enum(["provider", "validation", "configuration", "timeout", "external", "internal"]),
  provider: z.string().optional(),
  details: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.null()])
  ).optional(),
  executor: z.string().optional()
}) satisfies z.ZodType<JobError>;

export const answerQuestionInputSchema = z.object({
  provider: providerSchema,
  questionLogId: z.string().optional(),
  question: z.string(),
  flows: z.array(z.object({
    id: z.string(),
    name: z.string(),
    persona: z.string().optional()
  })),
  expectedOutput: z.literal("answer_result")
}) satisfies z.ZodType<ProviderInput<CoreAnswerQuestionJobInput>>;
export const answerQuestionOutputSchema = z.object({
  answer: z.string(),
  confidence: confidenceSchema,
  citations: z.array(citationSchema),
  gaps: z.array(gapSchema).optional(),
  flowId: z.string().optional()
}) satisfies z.ZodType<AnswerQuestionJobOutput>;

export const summarizeGapInputSchema = z.object({
  provider: providerSchema,
  questions: z.array(z.string()),
  citedSections: z.array(citationSchema),
  expectedOutput: z.literal("gap_summary")
}) satisfies z.ZodType<ProviderInput<CoreSummarizeGapJobInput>>;
export const summarizeGapOutputSchema = z.object({
  summary: z.string(),
  priority: z.number(),
  rationale: z.string()
}) satisfies z.ZodType<SummarizeGapJobOutput>;

const sourceDataContextSchema = z.object({
  sourceId: z.string(),
  sourceName: z.string(),
  kind: z.enum(["local", "git", "internet", "agent"]),
  path: z.string().optional(),
  url: z.string().optional(),
  content: z.string().optional()
});
// Mirrors @magpie/core OpenPullRequestContext. status reuses the core
// PROPOSAL_STATUSES tuple so the enum can't drift from the type it validates.
const openPullRequestContextSchema = z.object({
  title: z.string(),
  url: z.string().optional(),
  targetPath: z.string().optional(),
  status: z.enum(PROPOSAL_STATUSES)
});
export const draftMarkdownProposalInputSchema = z.object({
  provider: providerSchema,
  gapSummaries: z.array(z.string()),
  triggeringQuestions: z.array(z.string()),
  evidence: z.array(citationSchema),
  sourceContext: z.array(sourceDataContextSchema).optional(),
  // The drafter's awareness of the flow's in-flight work, so it can avoid
  // duplicating a doc already being drafted or in an open PR.
  openPullRequests: z.array(openPullRequestContextSchema).optional(),
  destinationId: z.string().optional(),
  targetPath: z.string().optional(),
  // Read back off the stored job input to link the created proposal to its
  // triggering questions; must be on the schema or the broker strips it.
  triggeringQuestionIds: z.array(z.string()).optional(),
  gapClusterId: z.string().optional(),
  expectedOutput: z.literal("markdown_proposal")
}) satisfies z.ZodType<ProviderInput<CoreDraftMarkdownProposalJobInput>>;
export const draftMarkdownProposalOutputSchema = z.object({
  title: z.string(),
  targetPath: z.string(),
  markdown: z.string(),
  rationale: z.string()
}) satisfies z.ZodType<DraftMarkdownProposalJobOutput>;

export const foldMarkdownProposalInputSchema = z.object({
  provider: providerSchema,
  survivorProposalId: z.string(),
  rivalProposalId: z.string(),
  targetPath: z.string(),
  survivorMarkdown: z.string(),
  rivalMarkdown: z.string(),
  rivalGapSummaries: z.array(z.string()),
  rivalEvidence: z.array(citationSchema),
  expectedOutput: z.literal("folded_markdown")
}) satisfies z.ZodType<ProviderInput<CoreFoldMarkdownProposalJobInput>>;
export const foldMarkdownProposalOutputSchema = z.object({
  markdown: z.string(),
  rationale: z.string()
}) satisfies z.ZodType<FoldMarkdownProposalJobOutput>;

// A single-PR comment as a github job (the API holds no GitHub token, so commenting
// must run in the watcher). crosslink_pull_requests can't serve here — it needs two
// PRs, and a folded-away rival never has one.
export const commentPullRequestInputSchema = z.object({
  pullRequestUrl: z.string(),
  body: z.string()
});
export const commentPullRequestOutputSchema = z.object({
  commentUrl: z.string().optional()
});

export const detectContradictionInputSchema = z.object({
  provider: providerSchema,
  documents: z.array(documentSchema)
});
export const detectContradictionOutputSchema = z.object({
  contradictions: z.array(z.object({ summary: z.string(), paths: z.array(z.string()).min(2) }))
});

export const suggestConsolidationInputSchema = z.object({
  provider: providerSchema,
  documents: z.array(documentSchema)
});
export const suggestConsolidationOutputSchema = z.object({
  suggestions: z.array(z.object({ title: z.string(), reason: z.string(), paths: z.array(z.string()).min(1) }))
});

const crunchOperationSchema = z.object({
  kind: z.enum(["consolidate", "split", "rewrite"]),
  title: z.string(),
  reason: z.string(),
  // The model routinely omits these when empty (e.g. the source-change-sync
  // prompt forbids deletes outright), so default rather than reject — an absent
  // array means "none of these", which is what the downstream changeset wants.
  sources: z.array(z.string()).default([]),
  writes: z.array(documentSchema).default([]),
  deletes: z.array(z.string()).default([])
});
export const crunchKnowledgeBaseInputSchema = z.object({
  provider: providerSchema,
  flowId: z.string().optional(),
  destinationId: z.string().optional(),
  documents: z.array(documentSchema),
  expectedOutput: z.literal("crunch_plan")
}) satisfies z.ZodType<ProviderInput<CoreCrunchKnowledgeBaseJobInput>>;
export const crunchKnowledgeBaseOutputSchema = z.object({
  summary: z.string(),
  operations: z.array(crunchOperationSchema),
  rationale: z.string()
}) satisfies z.ZodType<CrunchKnowledgeBaseJobOutput>;

export const clusterGapCandidatesInputSchema = z.object({
  candidates: z.array(z.object({ summary: z.string(), questionIds: z.array(z.string()) })),
  provider: providerSchema
});
export const clusterGapCandidatesOutputSchema = z.object({
  clusters: z.array(z.object({ label: z.string(), summaries: z.array(z.string()).min(1) }))
});

export const reconcileGapClustersInputSchema = z.object({
  clusters: z.array(z.object({
    id: z.string(),
    flowId: z.string().optional(),
    title: z.string()
  })),
  flowId: z.string().optional(),
  provider: providerSchema
});
export const reconcileGapClustersOutputSchema = z.object({
  merges: z.array(z.object({
    clusterIds: z.array(z.string()),
    rationale: z.string(),
    confirmed: z.boolean()
  })),
  splits: z.array(z.object({
    clusterId: z.string(),
    children: z.array(z.object({ gapIds: z.array(z.string()) })),
    rationale: z.string(),
    confirmed: z.boolean()
  }))
});

const sourceChangeFileSchema = z.object({
  path: z.string(),
  status: z.enum(["added", "modified", "deleted", "renamed", "other"]),
  diff: z.string()
});
export const syncSourceChangesGeneratePlanInputSchema = z.object({
  provider: providerSchema,
  flowId: z.string().optional(),
  destinationId: z.string().optional(),
  sourceId: z.string(),
  sourceName: z.string(),
  fromSha: z.string(),
  toSha: z.string(),
  changes: z.array(sourceChangeFileSchema),
  candidateDocuments: z.array(documentSchema),
  expectedOutput: z.literal("crunch_plan")
}) satisfies z.ZodType<ProviderInput<CoreSourceChangeSyncJobInput>>;
export const syncSourceChangesGeneratePlanOutputSchema = z.object({
  summary: z.string(),
  operations: z.array(crunchOperationSchema),
  rationale: z.string()
}) satisfies z.ZodType<CrunchPlan>;

export const verifyDocumentInputSchema = z.object({
  provider: providerSchema,
  path: z.string(),
  content: z.string(),
  sources: z.array(sourceDataContextSchema)
}) satisfies z.ZodType<ProviderInput<CoreVerifyDocumentJobInput>>;
export const verifyDocumentOutputSchema = z.object({
  verdict: z.enum(["healthy", "unprovable"]),
  claims: z.array(z.object({ claim: z.string(), reason: z.string() }))
}) satisfies z.ZodType<VerifyDocumentJobOutput>;

export const correctDocumentInputSchema = z.object({
  provider: providerSchema,
  path: z.string(),
  content: z.string(),
  claims: z.array(z.object({ claim: z.string(), reason: z.string() })),
  sources: z.array(sourceDataContextSchema),
  destinationId: z.string().optional(),
  flowId: z.string().optional()
}) satisfies z.ZodType<ProviderInput<CoreCorrectDocumentJobInput>>;
export const correctDocumentOutputSchema = z.object({
  markdown: z.string(),
  rationale: z.string()
}) satisfies z.ZodType<CorrectDocumentJobOutput>;

const changesetChangeSchema = z.object({
  path: z.string(),
  content: z.string().optional(),
  delete: z.boolean().optional()
}) satisfies z.ZodType<ChangesetChange>;

export const dedupeDocumentsInputSchema = z.object({
  provider: providerSchema,
  path: z.string(),
  content: z.string(),
  neighbours: z.array(z.object({ path: z.string(), content: z.string() })),
  destinationId: z.string().optional(),
  flowId: z.string().optional()
}) satisfies z.ZodType<ProviderInput<CoreDedupeDocumentsJobInput>>;
export const dedupeDocumentsOutputSchema = z.object({
  duplicate: z.boolean(),
  rationale: z.string(),
  primaryPath: z.string().optional(),
  changeset: z.array(changesetChangeSchema).optional()
}) satisfies z.ZodType<DedupeDocumentsJobOutput>;

export const splitDocumentInputSchema = z.object({
  provider: providerSchema,
  path: z.string(),
  content: z.string(),
  neighbours: z.array(z.object({ path: z.string(), content: z.string() })),
  destinationId: z.string().optional(),
  flowId: z.string().optional()
}) satisfies z.ZodType<ProviderInput<CoreSplitDocumentJobInput>>;
export const splitDocumentOutputSchema = z.object({
  split: z.boolean(),
  rationale: z.string(),
  primaryPath: z.string().optional(),
  changeset: z.array(changesetChangeSchema).optional()
}) satisfies z.ZodType<SplitDocumentJobOutput>;

export const improveDocumentInputSchema = z.object({
  provider: providerSchema,
  path: z.string(),
  content: z.string(),
  sources: z.array(sourceDataContextSchema),
  destinationId: z.string().optional(),
  flowId: z.string().optional()
}) satisfies z.ZodType<ProviderInput<CoreImproveDocumentJobInput>>;
export const improveDocumentOutputSchema = z.union([
  z.object({ improved: z.literal(false), rationale: z.string(), markdown: z.string().optional() }),
  z.object({ improved: z.literal(true), markdown: z.string(), rationale: z.string() })
]) satisfies z.ZodType<ImproveDocumentJobOutput>;

export const foldChangesetProposalInputSchema = z.object({
  provider: providerSchema,
  survivorProposalId: z.string(),
  rivalProposalId: z.string(),
  survivorChangeset: z.array(changesetChangeSchema),
  rivalChangeset: z.array(changesetChangeSchema),
  sharedPaths: z.array(z.string()),
  expectedOutput: z.literal("folded_changeset")
}) satisfies z.ZodType<ProviderInput<CoreFoldChangesetProposalJobInput>>;
export const foldChangesetProposalOutputSchema = z.object({
  changeset: z.array(changesetChangeSchema),
  rationale: z.string()
}) satisfies z.ZodType<FoldChangesetProposalJobOutput>;

export const refreshPullRequestsInputSchema = z.object({});
export const refreshPullRequestsOutputSchema = z.object({
  results: z.array(z.object({
    proposalId: z.string(),
    state: z.enum(["open", "closed"]),
    merged: z.boolean(),
    // Mirrors @magpie/core ReviewDecision. Optional: the watcher only attaches it
    // for still-open PRs it could read; a missing value means "undetermined".
    reviewDecision: z.enum(["approved", "changes_requested", "review_required", "none"]).optional()
  }))
});

export const processGapsToPullRequestsInputSchema = z.object({});
export const processGapsToPullRequestsOutputSchema = z.object({
  drafted: z.number().int(),
  published: z.number().int()
});

export const triggerScheduledCrunchInputSchema = z.object({ flowId: z.string().optional() });
export const triggerScheduledCrunchOutputSchema = z.object({ runId: z.string(), jobId: z.string() });

export const publishProposalInputSchema = z.object({ proposalId: z.string() });
export const publishProposalOutputSchema = z.object({
  proposalId: z.string(),
  branchName: z.string(),
  commitSha: z.string(),
  remoteUrl: z.string().optional(),
  pullRequestUrl: z.string().optional(),
  publishedAt: z.string()
});

export const publishCrunchInputSchema = z.object({ runId: z.string() });
export const publishCrunchOutputSchema = z.object({
  runId: z.string(),
  branchName: z.string(),
  commitSha: z.string(),
  remoteUrl: z.string().optional(),
  pullRequestUrl: z.string().optional(),
  publishedAt: z.string()
});

export const sourceChangeSyncInputSchema = z.object({ flowId: z.string().optional() });
// triggerSourceSyncRun reacts to 0..N git sources per flow, creating one run per
// source that had a new commit to consider. The output honestly reports every run
// id created (empty when no source had a change worth a run).
export const sourceChangeSyncOutputSchema = z.object({
  runIds: z.array(z.string())
});

export const fixPatrolInputSchema = z.object({ flowId: z.string().optional() });
// Per tick the patrol records exactly one run; the output reports its id and how
// many documents it checked (0 when the flow has no indexed documents yet).
export const fixPatrolOutputSchema = z.object({
  runId: z.string(),
  selectedCount: z.number().int(),
  findingCount: z.number().int()
});

export const improvePatrolInputSchema = z.object({ flowId: z.string().optional() });
export const improvePatrolOutputSchema = z.object({
  runId: z.string(),
  selectedCount: z.number().int(),
  enqueuedCount: z.number().int()
});

export const publishSourceSyncInputSchema = z.object({ runId: z.string() });
export const publishSourceSyncOutputSchema = z.object({
  runId: z.string(),
  branchName: z.string(),
  commitSha: z.string(),
  remoteUrl: z.string().optional(),
  publishedAt: z.string()
});

export const crosslinkPullRequestsInputSchema = z.object({
  flowId: z.string().optional(),
  targets: z.array(z.string()),
  pullRequests: z
    .array(z.object({ proposalId: z.string(), pullRequestUrl: z.string() }))
    .length(2)
});
export const crosslinkPullRequestsOutputSchema = z.object({
  commented: z.array(z.string()),
  linkedAt: z.string()
});
