import type { ChatProvider } from "@magpie/core";
import type { JobType, JobView } from "@magpie/jobs";
import {
  JOB_TYPES,
  jobDefinition,
  answerQuestionInputSchema,
  reconcileGapClustersInputSchema,
  reconcileGapClustersOutputSchema
} from "@magpie/jobs";
import { ANSWER_QUESTION, GAP_RECONCILE_CRITIC, GAP_RECONCILE_PROPOSE, withPersona } from "@magpie/prompts";
import { routeQuestionToFlow, type FlowRoute, type RoutableFlow } from "@magpie/retrieval";
import type { z } from "zod";
import type { WatcherApi } from "../http-client.js";
import { logger } from "../logger.js";
import {
  buildAnswerOutput,
  buildFlowSelectionRequiredOutput,
  buildPrompt,
  parseJobOutput
} from "../job-prompts.js";

export interface GenerativeJobOptions {
  job: JobView;
  model: ChatProvider;
  api: WatcherApi;
  signal: AbortSignal;
  buildPromptOverride?: (job: JobView) => string;
}

export const PROVIDER_JOB_TYPES: ReadonlySet<JobType> = new Set(
  JOB_TYPES.filter((type) => {
    try {
      return jobDefinition(type).requiredCapability({ provider: "codex" }) === "codex";
    } catch {
      return false;
    }
  })
);

type ReconcileOutput = z.infer<typeof reconcileGapClustersOutputSchema>;
type ProposedMerge = { clusterIds: string[]; rationale: string };
type ProposedSplit = { clusterId: string; children: Array<{ gapIds: string[] }>; rationale: string };

export async function runGenerativeJob(options: GenerativeJobOptions): Promise<unknown> {
  const { job } = options;
  if (job.type === "answer_question") {
    return answer(options);
  }
  if (job.type === "reconcile_gap_clusters") {
    return reconcileGapClusters(options);
  }

  const prompt = options.buildPromptOverride ? options.buildPromptOverride(job) : buildPrompt(job);
  const response = await options.model.complete({
    system: ANSWER_QUESTION.instructions,
    messages: [{ role: "user", content: prompt }],
    signal: options.signal
  });
  return parseJobOutput(job, response.content);
}

async function answer({ job, model, api, signal }: GenerativeJobOptions): Promise<unknown> {
  const input = answerQuestionInputSchema.parse(job.input);
  const flows: RoutableFlow[] = input.flows.map((flow) => ({
    id: flow.id,
    name: flow.name,
    ...(flow.persona ? { persona: flow.persona } : {})
  }));

  const route = await resolveFlow(input.requestedFlowId, input.question, flows, model, job.id);

  // "auto" routing could not pick a flow: withhold the answer and ask the caller
  // to choose one of the configured flows and re-ask.
  if (route.status === "unknown") {
    logger.debug({ jobId: job.id }, `answer_question[${job.id}]: routing unknown; requesting flow selection`);
    return buildFlowSelectionRequiredOutput(flows);
  }

  const flowId = route.status === "routed" ? route.flowId : undefined;
  const routedFlow = flowId ? flows.find((flow) => flow.id === flowId) : undefined;

  logger.debug({ jobId: job.id, flowId: flowId ?? null }, `answer_question[${job.id}]: retrieving sections for flow ${flowId ?? "(unscoped)"}`);
  const sections = await api.retrieve(input.question, flowId, undefined);

  logger.debug({ jobId: job.id, sectionCount: sections.length }, `answer_question[${job.id}]: generating answer from ${sections.length} section(s)`);
  const context = sections.map((section) => `# ${section.heading}\n${section.content}`).join("\n\n");
  const response = await model.complete({
    system: withPersona(ANSWER_QUESTION.instructions, routedFlow?.persona),
    messages: [{ role: "user", content: `Question:\n${input.question}\n\nContext:\n${context}` }],
    signal
  });

  return buildAnswerOutput(response.content, sections, input.question, flowId);
}

// Resolves which flow answers the question. A caller-pinned flow
// (`requestedFlowId`, already validated at the API) skips routing entirely;
// otherwise the model routes across the configured flows.
async function resolveFlow(
  requestedFlowId: string | undefined,
  question: string,
  flows: RoutableFlow[],
  model: ChatProvider,
  jobId: string
): Promise<FlowRoute> {
  if (requestedFlowId) {
    logger.debug({ jobId, flowId: requestedFlowId }, `answer_question[${jobId}]: using caller-specified flow ${requestedFlowId}`);
    return { status: "routed", flowId: requestedFlowId, confidence: "high" };
  }

  logger.debug({ jobId, flowCount: flows.length }, `answer_question[${jobId}]: routing question across ${flows.length} flow(s)`);
  return routeQuestionToFlow(question, flows, model, logger);
}

async function reconcileGapClusters({ job, model, signal }: GenerativeJobOptions): Promise<ReconcileOutput> {
  const input = reconcileGapClustersInputSchema.parse(job.input);

  const summary = input.clusters
    .map((cluster) => `cluster ${cluster.id} (flow ${cluster.flowId ?? "none"}): ${cluster.title}`)
    .join("\n");
  logger.debug({ jobId: job.id, clusterCount: input.clusters.length }, `reconcile_gap_clusters[${job.id}]: proposing reshape over ${input.clusters.length} cluster(s)`);
  const proposeResponse = await model.complete({
    system: GAP_RECONCILE_PROPOSE.instructions,
    messages: [{ role: "user", content: summary }],
    signal
  });
  const proposal = parseReshape(proposeResponse.content);

  logger.debug(
    { jobId: job.id, mergeCount: proposal.merges.length, splitCount: proposal.splits.length },
    `reconcile_gap_clusters[${job.id}]: critic-confirming ${proposal.merges.length} merge(s), ${proposal.splits.length} split(s)`
  );
  const merges: ReconcileOutput["merges"] = [];
  for (const merge of proposal.merges) {
    const confirmed = await criticConfirm(model, "merge", merge.rationale, signal);
    merges.push({ clusterIds: merge.clusterIds, rationale: merge.rationale, confirmed });
  }
  const splits: ReconcileOutput["splits"] = [];
  for (const split of proposal.splits) {
    const confirmed = await criticConfirm(model, "split", split.rationale, signal);
    splits.push({ clusterId: split.clusterId, children: split.children, rationale: split.rationale, confirmed });
  }

  return reconcileGapClustersOutputSchema.parse({ merges, splits });
}

async function criticConfirm(
  model: ChatProvider,
  kind: "merge" | "split",
  rationale: string,
  signal: AbortSignal
): Promise<boolean> {
  const response = await model.complete({
    system: GAP_RECONCILE_CRITIC.instructions,
    messages: [{ role: "user", content: `Proposed ${kind}. Rationale: ${rationale}` }],
    signal
  });
  try {
    const parsed = JSON.parse(response.content) as { confirmed?: unknown };
    return parsed.confirmed === true;
  } catch {
    return false;
  }
}

function parseReshape(content: string): { merges: ProposedMerge[]; splits: ProposedSplit[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { merges: [], splits: [] };
  }
  if (!parsed || typeof parsed !== "object") {
    return { merges: [], splits: [] };
  }
  const candidate = parsed as { merges?: unknown; splits?: unknown };
  return {
    merges: Array.isArray(candidate.merges) ? candidate.merges.filter(isProposedMerge) : [],
    splits: Array.isArray(candidate.splits) ? candidate.splits.filter(isProposedSplit) : []
  };
}

function isProposedMerge(value: unknown): value is ProposedMerge {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { clusterIds?: unknown; rationale?: unknown };
  return (
    Array.isArray(candidate.clusterIds) &&
    candidate.clusterIds.every((id) => typeof id === "string") &&
    typeof candidate.rationale === "string"
  );
}

function isProposedSplit(value: unknown): value is ProposedSplit {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { clusterId?: unknown; children?: unknown; rationale?: unknown };
  return (
    typeof candidate.clusterId === "string" &&
    typeof candidate.rationale === "string" &&
    Array.isArray(candidate.children) &&
    candidate.children.every(
      (child) =>
        Boolean(child) &&
        typeof child === "object" &&
        Array.isArray((child as { gapIds?: unknown }).gapIds) &&
        (child as { gapIds: unknown[] }).gapIds.every((id) => typeof id === "string")
    )
  );
}
