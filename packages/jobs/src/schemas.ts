import { z } from "zod";
import { PROPOSAL_STATUSES } from "@magpie/core";
import type {
  AnswerQuestionJobInput as CoreAnswerQuestionJobInput,
  AnswerQuestionJobOutput,
  MaintenancePlan,
  DraftMarkdownProposalJobInput as CoreDraftMarkdownProposalJobInput,
  DraftMarkdownProposalJobOutput,
  DraftSeedDocumentJobInput as CoreDraftSeedDocumentJobInput,
  DraftSeedDocumentJobOutput,
  OutlineFlowSeedJobInput as CoreOutlineFlowSeedJobInput,
  OutlineFlowSeedJobOutput,
  SeedItem,
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
  excerpt: z.string(),
  relevance: z.number()
});
const gapSchema = z.object({
  summary: z.string(),
  question: z.string(),
  confidence: confidenceSchema,
  citedSectionIds: z.array(z.string()),
  source: z.enum(["auto", "manual", "followup"])
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

const flowSelectionRequiredSchema = z.object({
  availableFlows: z.array(z.object({ id: z.string(), name: z.string() }))
});
const outOfScopeSchema = z.object({
  reason: z.string().optional()
});
// The watcher's audit trail for an answer (routing, searches with hit counts,
// grounding-verification outcome). Must be declared here or the broker strips it
// from the completed output before it reaches the question log.
const answerTraceSchema = z.object({
  routing: z.object({
    mode: z.enum(["requested", "routed", "unscoped", "unknown"]),
    flowId: z.string().optional(),
    confidence: confidenceSchema.optional()
  }),
  seedSectionCount: z.number().int().nonnegative(),
  searches: z.array(
    z.object({
      query: z.string(),
      resultCount: z.number().int().nonnegative(),
      round: z.number().int().positive()
    })
  ),
  poolSectionCount: z.number().int().nonnegative(),
  answerForced: z.boolean(),
  answerContract: z.enum(["structured", "unstructured"]).optional(),
  verification: z.object({
    status: z.enum(["grounded", "claims_stripped", "verdict_unparseable", "skipped"]),
    skipReason: z.enum(["low_confidence", "no_sections", "flow_selection_required", "out_of_scope"]).optional(),
    unsupportedClaims: z.array(z.string()).optional()
  })
});
export const answerQuestionInputSchema = z.object({
  provider: providerSchema,
  questionLogId: z.string().optional(),
  question: z.string(),
  flows: z.array(z.object({
    id: z.string(),
    name: z.string(),
    persona: z.string().optional()
  })),
  requestedFlowId: z.string().optional(),
  expectedOutput: z.literal("answer_result")
}) satisfies z.ZodType<ProviderInput<CoreAnswerQuestionJobInput>>;
export const answerQuestionOutputSchema = z.object({
  answer: z.string(),
  confidence: confidenceSchema,
  citations: z.array(citationSchema),
  gaps: z.array(gapSchema).optional(),
  flowId: z.string().optional(),
  flowSelectionRequired: flowSelectionRequiredSchema.optional(),
  outOfScope: outOfScopeSchema.optional(),
  trace: answerTraceSchema.optional()
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
  // Why a prior merged proposal failed to close these gaps, carried on a
  // resubmission so the drafter can address the specific shortfall (see the
  // gap `note` set by verify_gap_closure).
  resubmissionNotes: z.array(z.string()).optional(),
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

export const draftSeedDocumentInputSchema = z.object({
  provider: providerSchema,
  flowId: z.string(),
  title: z.string().optional(),
  targetPath: z.string().optional(),
  coverage: z.array(z.string()),
  questions: z.array(z.string()).optional(),
  sourceContext: z.array(sourceDataContextSchema),
  destinationId: z.string().optional()
}) satisfies z.ZodType<ProviderInput<CoreDraftSeedDocumentJobInput>>;
export const draftSeedDocumentOutputSchema = z.object({
  title: z.string(),
  targetPath: z.string(),
  markdown: z.string(),
  rationale: z.string()
}) satisfies z.ZodType<DraftSeedDocumentJobOutput>;

const existingDocumentContextSchema = z.object({
  path: z.string(),
  heading: z.string(),
  excerpt: z.string()
});
// The seed item shape as the model RETURNS it: coverage may be empty in raw model
// output (a human edits before seeding, and the v1 seed endpoint enforces min(1)).
const seedItemSchema = z.object({
  title: z.string().optional(),
  targetPath: z.string().optional(),
  coverage: z.array(z.string()),
  questions: z.array(z.string()).optional()
}) satisfies z.ZodType<SeedItem>;
export const outlineFlowSeedInputSchema = z.object({
  provider: providerSchema,
  flowId: z.string(),
  topic: z.string(),
  notes: z.string().optional(),
  existingDocuments: z.array(existingDocumentContextSchema),
  persona: z.string().optional()
}) satisfies z.ZodType<ProviderInput<CoreOutlineFlowSeedJobInput>>;
export const outlineFlowSeedOutputSchema = z.object({
  items: z.array(seedItemSchema),
  rationale: z.string()
}) satisfies z.ZodType<OutlineFlowSeedJobOutput>;

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

const maintenanceOperationSchema = z.object({
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
export const reconcileGapClustersInputSchema = z.object({
  clusters: z.array(z.object({
    id: z.string(),
    flowId: z.string().optional(),
    title: z.string(),
    // Scope grounding attached by the API (via inline retrieval against the flow's
    // destination) so the model can judge whether a cluster is off-topic for the
    // knowledge base. `topRelevance` is the best retrieval relevance found for the
    // cluster's topic (0 when nothing matched); `snippets` are short excerpts of the
    // best matches. Absent when the flow has no destination content to retrieve from.
    scope: z.object({
      persona: z.string().optional(),
      topRelevance: z.number(),
      snippets: z.array(z.string())
    }).optional()
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
  })),
  // Clusters the model judged off-topic for the knowledge base (unrelated to the
  // source knowledge). Each is critic-confirmed; the reconciler dismisses confirmed
  // ones permanently so they never draft a proposal.
  dismissals: z.array(z.object({
    clusterId: z.string(),
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
  totalChangedFileCount: z.number().int().nonnegative().optional(),
  changedFilesTruncated: z.boolean().optional(),
  candidateDocuments: z.array(documentSchema),
  expectedOutput: z.literal("maintenance_plan")
}) satisfies z.ZodType<ProviderInput<CoreSourceChangeSyncJobInput>>;
export const syncSourceChangesGeneratePlanOutputSchema = z.object({
  summary: z.string(),
  operations: z.array(maintenanceOperationSchema),
  rationale: z.string()
}) satisfies z.ZodType<MaintenancePlan>;

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

export const refreshFlowSnapshotInputSchema = z.object({});
export const refreshFlowSnapshotOutputSchema = z.object({
  results: z.array(z.object({
    proposalId: z.string(),
    state: z.enum(["open", "closed"]),
    merged: z.boolean(),
    // Mirrors @magpie/core ReviewDecision. Optional: the watcher only attaches it
    // for still-open PRs it could read; a missing value means "undetermined".
    reviewDecision: z.enum(["approved", "changes_requested", "review_required", "none"]).optional()
  }))
});

export const processGapsToPullRequestsInputSchema = z.object({
  flowId: z.string()
});
export const processGapsToPullRequestsOutputSchema = z.object({
  drafted: z.number().int(),
  published: z.number().int()
});

// `destination` selects the publish queue/capability: a file:// destination routes
// to `local-git` (push only, no PR); anything else to `github`. Defaults to github
// so enqueues predating the field (and legacy jobs) keep the original behaviour.
export const publishProposalInputSchema = z.object({
  proposalId: z.string(),
  destination: z.enum(["github", "local-git"]).default("github")
});
export const publishProposalOutputSchema = z.object({
  proposalId: z.string(),
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

export const correctnessPatrolInputSchema = z.object({ flowId: z.string().optional() });
// Per tick the patrol records exactly one run; the output reports its id and how
// many documents it checked (0 when the flow has no indexed documents yet).
export const correctnessPatrolOutputSchema = z.object({
  runId: z.string(),
  selectedCount: z.number().int(),
  findingCount: z.number().int()
});

export const editorialPatrolInputSchema = z.object({ flowId: z.string().optional() });
export const editorialPatrolOutputSchema = z.object({
  runId: z.string(),
  selectedCount: z.number().int(),
  enqueuedCount: z.number().int()
});

export const verifyGapClosureInputSchema = z.object({ proposalId: z.string() });
export const verifyGapClosureOutputSchema = z.object({
  proposalId: z.string(),
  closureStatus: z.enum(["verified_closed", "reopened", "needs_attention"]),
  perQuestion: z.array(
    z.object({
      questionId: z.string(),
      reaskedQuestionId: z.string().nullable(),
      verdict: z.enum(["closed", "still_open"])
    })
  )
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
