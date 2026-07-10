import type { ZodType } from "zod";
import * as schemas from "./schemas.js";
import {
  AI_PROVIDERS,
  JOB_TYPES,
  type JobCapability,
  type JobDefinition,
  type JobPolicy,
  type JobType,
  type QueueDefinition
} from "./types.js";

// How a job type maps onto capabilities/queues:
//  - a bare JobCapability: statically scoped, one queue named by the type;
//  - "provider": fans out over the four AI providers, keyed off input.provider;
//  - a fan-out spec: fans out over `capabilities`, keyed off input[field], with an
//    optional `default` used when the field is absent (backward-compatible enqueues).
type FanOutSpec = { field: string; capabilities: readonly JobCapability[]; default?: JobCapability };
type CapabilitySpec = JobCapability | "provider" | FanOutSpec;

// The one place the partitioned queue-name shape is defined: bare `type` for a
// single-capability job, `type__capability` (dashes → underscores) when it fans out.
function partitionedQueueName(type: JobType, capability: JobCapability, multi: boolean): string {
  return multi ? `${type}__${capability.replaceAll("-", "_")}` : type;
}

const DAY = 24 * 60 * 60;
const BASE_POLICY = {
  retryBackoff: true,
  heartbeatSeconds: 60,
  retentionSeconds: 14 * DAY,
  deleteAfterSeconds: 30 * DAY
} as const;

function policy(providerWork: boolean, expireInSeconds: number): Readonly<JobPolicy> {
  return Object.freeze({
    ...BASE_POLICY,
    retryLimit: providerWork ? 3 : 2,
    retryDelay: providerWork ? 15 : 30,
    retryDelayMax: providerWork ? 300 : 600,
    expireInSeconds
  });
}

function define(
  type: JobType,
  spec: CapabilitySpec,
  inputSchema: ZodType,
  outputSchema: ZodType,
  expireInSeconds: number
): JobDefinition {
  const providerWork = spec === "provider";
  const fanOut = typeof spec === "object";
  const capabilities: readonly JobCapability[] = providerWork
    ? AI_PROVIDERS
    : fanOut
      ? spec.capabilities
      : [spec];
  // The input field that selects the capability, and a fallback when it is absent.
  const field = providerWork ? "provider" : fanOut ? spec.field : undefined;
  const fallback = fanOut ? spec.default : undefined;
  const multi = capabilities.length > 1;

  const requiredCapability = (input: unknown): JobCapability => {
    if (field === undefined) {
      return capabilities[0];
    }
    const value = (input as Record<string, unknown> | null | undefined)?.[field];
    if (value === undefined || value === null) {
      if (fallback) {
        return fallback;
      }
      throw new TypeError(`Job ${type} requires input.${field} to be one of: ${capabilities.join(", ")}`);
    }
    if (typeof value !== "string" || !(capabilities as readonly string[]).includes(value)) {
      throw new TypeError(`Job ${type} requires input.${field} to be one of: ${capabilities.join(", ")}`);
    }
    return value as JobCapability;
  };
  const queueName = (input: unknown): string => partitionedQueueName(type, requiredCapability(input), multi);

  return Object.freeze({
    type,
    inputSchema,
    outputSchema,
    policy: policy(providerWork, expireInSeconds),
    capabilities,
    requiredCapability,
    queueName
  });
}

const definitions: Readonly<Record<JobType, JobDefinition>> = Object.freeze({
  answer_question: define("answer_question", "provider", schemas.answerQuestionInputSchema, schemas.answerQuestionOutputSchema, 5 * 60),
  summarize_gap: define("summarize_gap", "provider", schemas.summarizeGapInputSchema, schemas.summarizeGapOutputSchema, 10 * 60),
  draft_markdown_proposal: define("draft_markdown_proposal", "provider", schemas.draftMarkdownProposalInputSchema, schemas.draftMarkdownProposalOutputSchema, 15 * 60),
  draft_seed_document: define("draft_seed_document", "provider", schemas.draftSeedDocumentInputSchema, schemas.draftSeedDocumentOutputSchema, 15 * 60),
  outline_flow_seed: define("outline_flow_seed", "provider", schemas.outlineFlowSeedInputSchema, schemas.outlineFlowSeedOutputSchema, 10 * 60),
  fold_markdown_proposal: define("fold_markdown_proposal", "provider", schemas.foldMarkdownProposalInputSchema, schemas.foldMarkdownProposalOutputSchema, 15 * 60),
  detect_contradiction: define("detect_contradiction", "provider", schemas.detectContradictionInputSchema, schemas.detectContradictionOutputSchema, 10 * 60),
  suggest_consolidation: define("suggest_consolidation", "provider", schemas.suggestConsolidationInputSchema, schemas.suggestConsolidationOutputSchema, 10 * 60),
  reconcile_gap_clusters: define("reconcile_gap_clusters", "provider", schemas.reconcileGapClustersInputSchema, schemas.reconcileGapClustersOutputSchema, 5 * 60),
  sync_source_changes_generate_plan: define("sync_source_changes_generate_plan", "provider", schemas.syncSourceChangesGeneratePlanInputSchema, schemas.syncSourceChangesGeneratePlanOutputSchema, 60 * 60),
  // verify/correct/improve are source-grounded agentic jobs (increment 3): like
  // the draft jobs, exploration runs for minutes (MAGPIE_AGENTIC_TIMEOUT_MS
  // defaults to 10 minutes), so the queue must not expire them at a one-shot horizon.
  verify_document: define("verify_document", "provider", schemas.verifyDocumentInputSchema, schemas.verifyDocumentOutputSchema, 15 * 60),
  correct_document: define("correct_document", "provider", schemas.correctDocumentInputSchema, schemas.correctDocumentOutputSchema, 15 * 60),
  dedupe_documents: define("dedupe_documents", "provider", schemas.dedupeDocumentsInputSchema, schemas.dedupeDocumentsOutputSchema, 10 * 60),
  split_document: define("split_document", "provider", schemas.splitDocumentInputSchema, schemas.splitDocumentOutputSchema, 10 * 60),
  improve_document: define("improve_document", "provider", schemas.improveDocumentInputSchema, schemas.improveDocumentOutputSchema, 15 * 60),
  fold_changeset_proposal: define("fold_changeset_proposal", "provider", schemas.foldChangesetProposalInputSchema, schemas.foldChangesetProposalOutputSchema, 15 * 60),
  refresh_flow_snapshot: define("refresh_flow_snapshot", "github", schemas.refreshFlowSnapshotInputSchema, schemas.refreshFlowSnapshotOutputSchema, 5 * 60),
  process_gaps_to_pull_requests: define("process_gaps_to_pull_requests", "maintenance", schemas.processGapsToPullRequestsInputSchema, schemas.processGapsToPullRequestsOutputSchema, 60 * 60),
  source_change_sync: define("source_change_sync", "maintenance", schemas.sourceChangeSyncInputSchema, schemas.sourceChangeSyncOutputSchema, 60 * 60),
  correctness_patrol: define("correctness_patrol", "maintenance", schemas.correctnessPatrolInputSchema, schemas.correctnessPatrolOutputSchema, 60 * 60),
  editorial_patrol: define("editorial_patrol", "maintenance", schemas.editorialPatrolInputSchema, schemas.editorialPatrolOutputSchema, 60 * 60),
  verify_gap_closure: define("verify_gap_closure", "maintenance", schemas.verifyGapClosureInputSchema, schemas.verifyGapClosureOutputSchema, 60 * 60),
  seed_bootstrap: define("seed_bootstrap", "maintenance", schemas.seedBootstrapInputSchema, schemas.seedBootstrapOutputSchema, 60 * 60),
  // Publishing a branch to a file:// destination needs no GitHub token, so it fans
  // out over {github, local-git} keyed off input.destination. Enqueues that omit it
  // (legacy jobs) default to github, matching the pre-local-git behaviour.
  publish_proposal: define(
    "publish_proposal",
    { field: "destination", capabilities: ["github", "local-git"], default: "github" },
    schemas.publishProposalInputSchema,
    schemas.publishProposalOutputSchema,
    15 * 60
  ),
  crosslink_pull_requests: define("crosslink_pull_requests", "github", schemas.crosslinkPullRequestsInputSchema, schemas.crosslinkPullRequestsOutputSchema, 10 * 60),
  comment_pull_request: define("comment_pull_request", "github", schemas.commentPullRequestInputSchema, schemas.commentPullRequestOutputSchema, 10 * 60)
});

export function jobDefinition(type: JobType): JobDefinition {
  return definitions[type];
}

export function queueNameForJob(type: JobType, input: unknown): string {
  return jobDefinition(type).queueName(input);
}

// The provider-routed (metered) job types — every type whose work is done by a
// chat/generative AI provider. Exported so cost controls can count in-flight AI
// work (see the API's global concurrency cap) without re-deriving the list.
export const AI_JOB_TYPES = [
  "answer_question",
  "summarize_gap",
  "draft_markdown_proposal",
  "draft_seed_document",
  "outline_flow_seed",
  "fold_markdown_proposal",
  "detect_contradiction",
  "suggest_consolidation",
  "reconcile_gap_clusters",
  "sync_source_changes_generate_plan",
  "verify_document",
  "correct_document",
  "dedupe_documents",
  "split_document",
  "improve_document",
  "fold_changeset_proposal"
] as const satisfies readonly JobType[];

const aiJobTypes = new Set<JobType>(AI_JOB_TYPES);

// Whether a job type is provider-routed (metered AI work). Kept in sync with
// AI_JOB_TYPES, the single source of truth above.
export function isAiJobType(type: JobType): boolean {
  return aiJobTypes.has(type);
}

// The interactive class of AI work: jobs a live caller is waiting on right now —
// POST /api/ask (answer_question, including verify_gap_closure's re-asks, which
// a blocked orchestrator bounded-waits on) and the console's flow outline
// (outline_flow_seed). Every other AI_JOB_TYPES member is maintenance fan-out
// that nobody is sitting in front of. This split drives the two QoS levers for
// #240: brokers probe interactive queues first when a watcher claims, and the
// API's AI capacity gate reserves interactive headroom at enqueue time.
export const INTERACTIVE_AI_JOB_TYPES = [
  "answer_question",
  "outline_flow_seed"
] as const satisfies readonly JobType[];

const interactiveJobTypes = new Set<JobType>(INTERACTIVE_AI_JOB_TYPES);

// Whether a job type belongs to the interactive class above. Used by brokers to
// order queue probes during claim, so it must stay a pure catalog fact.
export function isInteractiveJobType(type: JobType): boolean {
  return interactiveJobTypes.has(type);
}

function concreteWorkQueues(): QueueDefinition[] {
  return JOB_TYPES.flatMap((type) => {
    const definition = jobDefinition(type);
    return definition.capabilities.map((capability) => concreteQueue(definition, capability));
  });
}

function concreteQueue(definition: JobDefinition, capability: JobCapability): QueueDefinition {
  const name = partitionedQueueName(definition.type, capability, definition.capabilities.length > 1);
  const deadLetter = `${name}__dead_letter`;
  return Object.freeze({
    name,
    type: definition.type,
    capability,
    deadLetter: false,
    policy: Object.freeze({ ...definition.policy, deadLetter })
  });
}

const workQueues = concreteWorkQueues();

const queueDefinitions: readonly QueueDefinition[] = Object.freeze([
  ...workQueues,
  ...workQueues.map((queue) => Object.freeze({
    name: queue.policy!.deadLetter!,
    type: queue.type,
    deadLetter: true
  }))
]);

export function allQueueDefinitions(): QueueDefinition[] {
  return [...queueDefinitions];
}

export function queueNamesForCapabilities(capabilities: readonly JobCapability[]): string[] {
  const accepted = new Set(capabilities);
  return workQueues.filter((queue) => accepted.has(queue.capability!)).map((queue) => queue.name);
}

// The job types a single capability can execute (a type is included if that
// capability is among the ones it routes to). The console renders one worker's
// reach from this, so it can never drift from the catalog the way a hand-kept map
// would.
export function jobTypesForCapability(capability: JobCapability): JobType[] {
  return JOB_TYPES.filter((type) => jobDefinition(type).capabilities.includes(capability));
}

// The job types no capability in `available` can execute — i.e. the coverage gap
// for a running watcher fleet. A type counts as covered if ANY of its capabilities
// is available (so publish_proposal is covered by github OR local-git). Drives the
// "no watcher can run these jobs" console banner.
export function jobTypesWithoutCapabilities(available: Iterable<string>): JobType[] {
  const accepted = new Set(available);
  return JOB_TYPES.filter((type) => !jobDefinition(type).capabilities.some((capability) => accepted.has(capability)));
}
