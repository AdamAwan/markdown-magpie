import type { ZodType } from "zod";
import * as schemas from "./schemas.js";
import {
  AI_PROVIDERS,
  JOB_TYPES,
  isAiProviderName,
  type AiProviderName,
  type JobCapability,
  type JobDefinition,
  type JobPolicy,
  type JobType,
  type QueueDefinition
} from "./types.js";

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
  capability: JobCapability | "provider",
  inputSchema: ZodType,
  outputSchema: ZodType,
  expireInSeconds: number
): JobDefinition {
  const providerWork = capability === "provider";
  const requiredCapability = (input: unknown): JobCapability => {
    if (!providerWork) {
      return capability;
    }
    const provider = (input as { provider?: unknown } | null)?.provider;
    if (!isAiProviderName(provider)) {
      throw new TypeError(`AI job ${type} requires a valid provider`);
    }
    return provider;
  };
  const queueName = (input: unknown): string => {
    const required = requiredCapability(input);
    return providerWork ? `${type}__${required.replaceAll("-", "_")}` : type;
  };
  return Object.freeze({
    type,
    inputSchema,
    outputSchema,
    policy: policy(providerWork, expireInSeconds),
    requiredCapability,
    queueName
  });
}

const definitions: Readonly<Record<JobType, JobDefinition>> = Object.freeze({
  answer_question: define("answer_question", "provider", schemas.answerQuestionInputSchema, schemas.answerQuestionOutputSchema, 5 * 60),
  summarize_gap: define("summarize_gap", "provider", schemas.summarizeGapInputSchema, schemas.summarizeGapOutputSchema, 10 * 60),
  draft_markdown_proposal: define("draft_markdown_proposal", "provider", schemas.draftMarkdownProposalInputSchema, schemas.draftMarkdownProposalOutputSchema, 15 * 60),
  fold_markdown_proposal: define("fold_markdown_proposal", "provider", schemas.foldMarkdownProposalInputSchema, schemas.foldMarkdownProposalOutputSchema, 15 * 60),
  detect_contradiction: define("detect_contradiction", "provider", schemas.detectContradictionInputSchema, schemas.detectContradictionOutputSchema, 10 * 60),
  suggest_consolidation: define("suggest_consolidation", "provider", schemas.suggestConsolidationInputSchema, schemas.suggestConsolidationOutputSchema, 10 * 60),
  crunch_knowledge_base: define("crunch_knowledge_base", "provider", schemas.crunchKnowledgeBaseInputSchema, schemas.crunchKnowledgeBaseOutputSchema, 60 * 60),
  cluster_gap_candidates: define("cluster_gap_candidates", "provider", schemas.clusterGapCandidatesInputSchema, schemas.clusterGapCandidatesOutputSchema, 5 * 60),
  reconcile_gap_clusters: define("reconcile_gap_clusters", "provider", schemas.reconcileGapClustersInputSchema, schemas.reconcileGapClustersOutputSchema, 5 * 60),
  sync_source_changes_generate_plan: define("sync_source_changes_generate_plan", "provider", schemas.syncSourceChangesGeneratePlanInputSchema, schemas.syncSourceChangesGeneratePlanOutputSchema, 60 * 60),
  verify_document: define("verify_document", "provider", schemas.verifyDocumentInputSchema, schemas.verifyDocumentOutputSchema, 10 * 60),
  refresh_pull_requests: define("refresh_pull_requests", "github", schemas.refreshPullRequestsInputSchema, schemas.refreshPullRequestsOutputSchema, 5 * 60),
  process_gaps_to_pull_requests: define("process_gaps_to_pull_requests", "maintenance", schemas.processGapsToPullRequestsInputSchema, schemas.processGapsToPullRequestsOutputSchema, 60 * 60),
  trigger_scheduled_crunch: define("trigger_scheduled_crunch", "maintenance", schemas.triggerScheduledCrunchInputSchema, schemas.triggerScheduledCrunchOutputSchema, 60 * 60),
  source_change_sync: define("source_change_sync", "maintenance", schemas.sourceChangeSyncInputSchema, schemas.sourceChangeSyncOutputSchema, 60 * 60),
  fix_patrol: define("fix_patrol", "maintenance", schemas.fixPatrolInputSchema, schemas.fixPatrolOutputSchema, 60 * 60),
  publish_proposal: define("publish_proposal", "github", schemas.publishProposalInputSchema, schemas.publishProposalOutputSchema, 15 * 60),
  publish_crunch: define("publish_crunch", "github", schemas.publishCrunchInputSchema, schemas.publishCrunchOutputSchema, 15 * 60),
  publish_source_sync: define("publish_source_sync", "github", schemas.publishSourceSyncInputSchema, schemas.publishSourceSyncOutputSchema, 15 * 60),
  crosslink_pull_requests: define("crosslink_pull_requests", "github", schemas.crosslinkPullRequestsInputSchema, schemas.crosslinkPullRequestsOutputSchema, 10 * 60),
  comment_pull_request: define("comment_pull_request", "github", schemas.commentPullRequestInputSchema, schemas.commentPullRequestOutputSchema, 10 * 60)
});

export function jobDefinition(type: JobType): JobDefinition {
  return definitions[type];
}

export function queueNameForJob(type: JobType, input: unknown): string {
  return jobDefinition(type).queueName(input);
}

const aiJobTypes = new Set<JobType>([
  "answer_question",
  "summarize_gap",
  "draft_markdown_proposal",
  "fold_markdown_proposal",
  "detect_contradiction",
  "suggest_consolidation",
  "crunch_knowledge_base",
  "cluster_gap_candidates",
  "reconcile_gap_clusters",
  "sync_source_changes_generate_plan",
  "verify_document"
]);

function concreteWorkQueues(): QueueDefinition[] {
  return JOB_TYPES.flatMap((type) => {
    const definition = jobDefinition(type);
    if (aiJobTypes.has(type)) {
      return AI_PROVIDERS.map((provider) => concreteQueue(definition, provider));
    }
    return [concreteQueue(definition, definition.requiredCapability({}))];
  });
}

function concreteQueue(definition: JobDefinition, capability: JobCapability): QueueDefinition {
  const input = aiJobTypes.has(definition.type) ? { provider: capability as AiProviderName } : {};
  const name = definition.queueName(input);
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
