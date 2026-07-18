import { z } from "zod";
import { PROPOSAL_STATUSES, isAllowedGitCloneUrl } from "@magpie/core";
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
  ReviseSeedPlanJobInput as CoreReviseSeedPlanJobInput,
  ReviseSeedPlanJobOutput,
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
  ChangesetChange,
  SourceMapUpdate,
  ProvenanceClaim
} from "@magpie/core";
import { AI_PROVIDERS, type AiProviderName, type JobError, type JobRepairContext } from "./types.js";

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
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
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
const answerCandidateSchema = z.object({
  itemId: z.string(),
  question: z.string(),
  answer: z.string()
});

const reconcileResultSchema = z.object({
  verdict: z.enum(["reused", "adapted", "merged", "fresh"]),
  basisItemIds: z.array(z.string())
});

export const answerQuestionInputSchema = z.object({
  provider: providerSchema,
  questionLogId: z.string().optional(),
  question: z.string(),
  flows: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      persona: z.string().optional()
    })
  ),
  requestedFlowId: z.string().optional(),
  // Multi-turn conversation context (#239). Declared here so the broker does not
  // strip it from the enqueued input (the schema-stripping gotcha).
  priorTurns: z.array(z.object({ question: z.string(), answer: z.string() })).optional(),
  conversationFlowId: z.string().optional(),
  // Prior approved items the watcher's reconciler can reuse/adapt/merge from
  // instead of answering fresh (questionnaire trust). Declared so the broker
  // preserves them from the enqueued input.
  candidates: z.array(answerCandidateSchema).optional(),
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
  trace: answerTraceSchema.optional(),
  // The condensed standalone form of a follow-up (#239). Declared so the broker
  // preserves it on completion for the API to persist on the question log.
  standaloneQuestion: z.string().optional(),
  // The reconciler's verdict when the job was given candidates to reconcile
  // against (questionnaire trust). Declared so the broker preserves it on
  // completion for the API to persist.
  reuse: reconcileResultSchema.optional()
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

// A git source url the watcher will hand to `git clone`. Restricted to the
// permitted transports (#285) so a caller crossing the POST /api/jobs boundary
// cannot smuggle an `ext::sh -c …` (RCE), `git://`, or `-`-prefixed (argument
// injection) url through a source descriptor. Mirrors the git package's clone-time
// guard; `file://` and bare local paths stay permitted (local-git repos).
const gitCloneUrlSchema = z.string().refine(isAllowedGitCloneUrl, { message: "url uses a disallowed git transport" });

// Mirrors @magpie/core SourceDescriptor. References only — no file content.
const sourceDescriptorSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string(),
    name: z.string(),
    kind: z.literal("git"),
    url: gitCloneUrlSchema,
    subpath: z.string().optional()
  }),
  z.object({
    id: z.string(),
    name: z.string(),
    kind: z.literal("local"),
    path: z.string(),
    subpath: z.string().optional()
  }),
  z.object({
    id: z.string(),
    name: z.string(),
    kind: z.literal("internet"),
    url: z.string().optional(),
    // Fetch allowlist (#242): without it (or empty) the source is a prompt note
    // only. Declared here or the watcher-side input parse strips it silently.
    allowedHosts: z.array(z.string()).optional()
  }),
  z.object({ id: z.string(), name: z.string(), kind: z.literal("agent") })
]);
// Mirrors @magpie/core SourceMapUpdate — an optional, agent-contributed
// source-map hint on source-grounded outputs. Must be on the schema or the
// broker strips it from the completed output before the API can apply it.
const sourceMapUpdateSchema = z.object({
  sourceId: z.string(),
  topic: z.string(),
  paths: z.array(z.string().min(1)).min(1),
  description: z.string(),
  observedSha: z.string().optional()
}) satisfies z.ZodType<SourceMapUpdate>;
const mapUpdatesField = z.array(sourceMapUpdateSchema).optional();
// Mirrors @magpie/core ProvenanceClaim — per-claim source grounding on draft
// outputs (#214). Must be on the schema or the broker strips it from the
// completed output before the API can persist it (same trap as mapUpdates).
const provenanceClaimSchema = z.object({
  claim: z.string().min(1),
  anchor: z.string().optional(),
  sources: z
    .array(
      z.object({
        sourceId: z.string(),
        path: z.string().optional(),
        lines: z.string().optional(),
        url: z.string().optional()
      })
    )
    .min(1)
}) satisfies z.ZodType<ProvenanceClaim>;
const provenanceField = z.array(provenanceClaimSchema).optional();
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
  // Mirrors @magpie/core SourceDescriptor. References only — no file content; the
  // watcher resolves git/local to traversable workspaces. Same schema the seed
  // input uses.
  sources: z.array(sourceDescriptorSchema),
  // The drafter's awareness of the flow's in-flight work, so it can avoid
  // duplicating a doc already being drafted or in an open PR.
  openPullRequests: z.array(openPullRequestContextSchema).optional(),
  destinationId: z.string().optional(),
  targetPath: z.string().optional(),
  // Read back off the stored job input to link the created proposal to its
  // triggering questions; must be on the schema or the broker strips it.
  triggeringQuestionIds: z.array(z.string()).optional(),
  gapClusterId: z.string().optional(),
  // Set when this draft regenerates an already-published proposal whose PR went
  // stale; the completion handler updates that proposal in place and re-publishes.
  regenerateProposalId: z.string().optional(),
  // Attribution only (read back off the stored job row for per-flow / per-schedule
  // cost); the drafter ignores it. Must be on the schema or the broker strips it.
  // Absent on the unscoped/default flow or when the flow cannot be resolved.
  flowId: z.string().optional(),
  expectedOutput: z.literal("markdown_proposal")
}) satisfies z.ZodType<ProviderInput<CoreDraftMarkdownProposalJobInput>>;
export const draftMarkdownProposalOutputSchema = z.object({
  title: z.string(),
  targetPath: z.string(),
  markdown: z.string(),
  rationale: z.string(),
  mapUpdates: mapUpdatesField,
  // #213: source-uncovered points, omitted from the markdown by contract. Must be
  // declared here or the broker strips it before the completion handler reads it.
  uncoveredPoints: z.array(z.string()).optional(),
  provenance: provenanceField
}) satisfies z.ZodType<DraftMarkdownProposalJobOutput>;

export const draftSeedDocumentInputSchema = z.object({
  provider: providerSchema,
  flowId: z.string(),
  title: z.string().optional(),
  targetPath: z.string().optional(),
  coverage: z.array(z.string()),
  questions: z.array(z.string()).optional(),
  sources: z.array(sourceDescriptorSchema),
  destinationId: z.string().optional(),
  // Run-scoped shaping from the seed plan; seedPlanId is read back at completion
  // to link the proposal (triggeringQuestionIds precedent) — must be on the
  // schema or the broker strips it.
  charter: z.string().optional(),
  persona: z.string().optional(),
  seedPlanId: z.string().optional()
}) satisfies z.ZodType<ProviderInput<CoreDraftSeedDocumentJobInput>>;
export const draftSeedDocumentOutputSchema = z.object({
  title: z.string(),
  targetPath: z.string(),
  markdown: z.string(),
  rationale: z.string(),
  mapUpdates: mapUpdatesField,
  // #213: see draftMarkdownProposalOutputSchema.uncoveredPoints.
  uncoveredPoints: z.array(z.string()).optional(),
  provenance: provenanceField
}) satisfies z.ZodType<DraftSeedDocumentJobOutput>;

const existingDocumentContextSchema = z.object({
  path: z.string(),
  heading: z.string(),
  excerpt: z.string().optional()
});
// The seed item shape as the model RETURNS it: coverage may be empty in raw model
// output (a human edits before approving, and plan approval enforces non-empty).
const seedItemSchema = z.object({
  title: z.string().optional(),
  targetPath: z.string().optional(),
  coverage: z.array(z.string()),
  questions: z.array(z.string()).optional()
}) satisfies z.ZodType<SeedItem>;
export const outlineFlowSeedInputSchema = z.object({
  provider: providerSchema,
  flowId: z.string(),
  origin: z.enum(["manual", "auto"]),
  notes: z.string().optional(),
  sources: z.array(sourceDescriptorSchema),
  existingDocuments: z.array(existingDocumentContextSchema),
  persona: z.string().optional(),
  charter: z.string().optional(),
  routingSummary: z.string().optional()
}) satisfies z.ZodType<ProviderInput<CoreOutlineFlowSeedJobInput>>;
export const outlineFlowSeedOutputSchema = z.object({
  items: z.array(seedItemSchema),
  rationale: z.string(),
  // Proposed only when the flow lacked them; must be declared or the broker
  // strips them before the plan-creation handler reads them.
  proposedCharter: z.string().optional(),
  proposedPersona: z.string().optional(),
  mapUpdates: mapUpdatesField
}) satisfies z.ZodType<OutlineFlowSeedJobOutput>;

export const reviseSeedPlanInputSchema = z.object({
  provider: providerSchema,
  flowId: z.string(),
  planId: z.string(),
  instruction: z.string(),
  currentPlan: z.object({
    items: z.array(seedItemSchema),
    charter: z.string().optional(),
    persona: z.string().optional(),
    rationale: z.string()
  })
}) satisfies z.ZodType<ProviderInput<CoreReviseSeedPlanJobInput>>;
export const reviseSeedPlanOutputSchema = z.object({
  items: z.array(seedItemSchema),
  rationale: z.string(),
  // Returned only when the instruction changed them; declared so the broker does
  // not strip them before the completion handler reads them.
  charter: z.string().optional(),
  persona: z.string().optional()
}) satisfies z.ZodType<ReviseSeedPlanJobOutput>;

export const foldMarkdownProposalInputSchema = z.object({
  provider: providerSchema,
  survivorProposalId: z.string(),
  rivalProposalId: z.string(),
  targetPath: z.string(),
  survivorMarkdown: z.string(),
  rivalMarkdown: z.string(),
  rivalGapSummaries: z.array(z.string()),
  rivalEvidence: z.array(citationSchema),
  // #214 phase 3: both parents' claim provenance, so the fold can re-attribute
  // every surviving claim to the folded document's headings.
  survivorProvenance: provenanceField,
  rivalProvenance: provenanceField,
  expectedOutput: z.literal("folded_markdown")
}) satisfies z.ZodType<ProviderInput<CoreFoldMarkdownProposalJobInput>>;
export const foldMarkdownProposalOutputSchema = z.object({
  markdown: z.string(),
  rationale: z.string(),
  // #214 phase 3: the merged document's provenance (union of the parents',
  // re-anchored). Must be on the schema or the broker strips it before the
  // API can rewrite the survivor's provenance event.
  provenance: provenanceField
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
  clusters: z.array(
    z.object({
      id: z.string(),
      flowId: z.string().optional(),
      title: z.string(),
      // Scope grounding attached by the API (via inline retrieval against the flow's
      // destination) so the model can judge whether a cluster is off-topic for the
      // knowledge base. `topRelevance` is the best retrieval relevance found for the
      // cluster's topic (0 when nothing matched); `snippets` are short excerpts of the
      // best matches. Absent when the flow has no destination content to retrieve from.
      scope: z
        .object({
          persona: z.string().optional(),
          topRelevance: z.number(),
          snippets: z.array(z.string())
        })
        .optional()
    })
  ),
  flowId: z.string().optional(),
  provider: providerSchema
});
export const reconcileGapClustersOutputSchema = z.object({
  merges: z.array(
    z.object({
      clusterIds: z.array(z.string()),
      rationale: z.string(),
      confirmed: z.boolean()
    })
  ),
  splits: z.array(
    z.object({
      clusterId: z.string(),
      children: z.array(z.object({ gapIds: z.array(z.string()) })),
      rationale: z.string(),
      confirmed: z.boolean()
    })
  ),
  // Clusters the model judged off-topic for the knowledge base (unrelated to the
  // source knowledge). Each is critic-confirmed; the reconciler dismisses confirmed
  // ones permanently so they never draft a proposal.
  dismissals: z.array(
    z.object({
      clusterId: z.string(),
      rationale: z.string(),
      confirmed: z.boolean()
    })
  )
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
  sources: z.array(sourceDescriptorSchema),
  // #214 phase 2: advisory per-claim provenance folded from the document's
  // merged proposals. The agent checks these against their cited locations
  // first; claims not listed here are re-derived from scratch as before.
  citedClaims: z.array(provenanceClaimSchema).optional(),
  // Attribution only (read back off the stored job row for per-flow / per-schedule
  // cost); the verify runner ignores it. Must be on the schema or the broker
  // strips it. Absent on the unscoped/default flow.
  flowId: z.string().optional()
}) satisfies z.ZodType<ProviderInput<CoreVerifyDocumentJobInput>>;
export const verifyDocumentOutputSchema = z.object({
  verdict: z.enum(["healthy", "unprovable"]),
  claims: z.array(z.object({ claim: z.string(), reason: z.string() })),
  mapUpdates: mapUpdatesField
}) satisfies z.ZodType<VerifyDocumentJobOutput>;

export const correctDocumentInputSchema = z.object({
  provider: providerSchema,
  path: z.string(),
  content: z.string(),
  claims: z.array(z.object({ claim: z.string(), reason: z.string() })),
  sources: z.array(sourceDescriptorSchema),
  destinationId: z.string().optional(),
  flowId: z.string().optional()
}) satisfies z.ZodType<ProviderInput<CoreCorrectDocumentJobInput>>;
export const correctDocumentOutputSchema = z.object({
  markdown: z.string(),
  rationale: z.string(),
  mapUpdates: mapUpdatesField,
  // #214 phase 3: the corrected claims this diff introduces or rewrites, so the
  // corrective proposal is a provenance event too.
  provenance: provenanceField
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
  sources: z.array(sourceDescriptorSchema),
  destinationId: z.string().optional(),
  flowId: z.string().optional()
}) satisfies z.ZodType<ProviderInput<CoreImproveDocumentJobInput>>;
export const improveDocumentOutputSchema = z.union([
  // The improved: false branch carries no provenance by design — a no-op
  // improvement grounds no new claims, so a stray field is stripped, not kept.
  z.object({
    improved: z.literal(false),
    rationale: z.string(),
    markdown: z.string().optional(),
    mapUpdates: mapUpdatesField
  }),
  // #214 phase 3: provenance for the claims the rewritten markdown introduces
  // or materially changes.
  z.object({
    improved: z.literal(true),
    markdown: z.string(),
    rationale: z.string(),
    mapUpdates: mapUpdatesField,
    provenance: provenanceField
  })
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
  results: z.array(
    z.object({
      proposalId: z.string(),
      state: z.enum(["open", "closed"]),
      merged: z.boolean(),
      // Mirrors @magpie/core ReviewDecision. Optional: the watcher only attaches it
      // for still-open PRs it could read; a missing value means "undetermined".
      reviewDecision: z.enum(["approved", "changes_requested", "review_required", "none"]).optional(),
      // Whether the still-open PR still merges cleanly. Optional: only attached for
      // open PRs the watcher could read a mergeable state for. "unknown" (or missing)
      // means undetermined and must never trigger regeneration.
      mergeable: z.enum(["mergeable", "conflicting", "unknown"]).optional()
    })
  )
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
  destination: z.enum(["github", "local-git"]).default("github"),
  // When true, the publisher re-cuts the branch from the current default-base tip
  // and force-pushes, updating the existing PR in place. Set by the stale-PR
  // regeneration path; absent/false for a first publish.
  regenerate: z.boolean().optional()
});
export const publishProposalOutputSchema = z.object({
  proposalId: z.string(),
  branchName: z.string(),
  commitSha: z.string(),
  remoteUrl: z.string().optional(),
  pullRequestUrl: z.string().optional(),
  publishedAt: z.string(),
  // True when the generated content was byte-identical to the base on a fresh
  // create, so no branch was pushed. The API settles the proposal as superseded
  // instead of recording a (non-existent) published branch.
  noChange: z.boolean().optional()
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

export const seedBootstrapInputSchema = z.object({ flowId: z.string() });
// One sparse-flow bootstrap tick: either it enqueued an outline_flow_seed run
// (outlineJobId reports which, possibly a reused in-flight one) or it no-oped
// and `reason` says why: no_sources | kb_populated | plan_pending |
// outline_in_flight | seed_proposals_open | dismissed_unchanged.
export const seedBootstrapOutputSchema = z.object({
  enqueued: z.boolean(),
  reason: z.string().optional(),
  outlineJobId: z.string().optional()
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
  pullRequests: z.array(z.object({ proposalId: z.string(), pullRequestUrl: z.string() })).length(2)
});
export const crosslinkPullRequestsOutputSchema = z.object({
  commented: z.array(z.string()),
  linkedAt: z.string()
});

// Out-of-band repair context for a schema-invalid provider job getting one
// informed repair (#288d). Persisted in the job-repair-context store keyed by job
// id — NOT in any domain inputSchema — and attached to the JobView at claim time
// (see JobRepairContext in types.ts). Kept here so the store and the API share
// one validated shape.
export const jobRepairContextSchema = z.object({
  attempt: z.number().int().positive(),
  priorOutput: z.unknown(),
  issues: z.array(z.object({ path: z.string(), message: z.string() }))
}) satisfies z.ZodType<JobRepairContext>;
